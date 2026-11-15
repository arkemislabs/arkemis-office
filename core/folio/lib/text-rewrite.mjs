// Writing an edited paragraph back: the paragraph's text, rewrapped to its box, replaces its runs in the page's content stream.
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/edit/src/text/rewrite.rs   refuse_clipping_text, coincident_ops (overlaps_half, on_same_baseline), choose_rewrite_path (the single-style path),
//                                     paragraph_text, ParaGeometry (width), margin_reach, turned_line_width, Advance, choose_font (the source font's glyphs,
//                                     else a standard face as /PCEd<Face> with a notice), drawn_movement, emit_text_matrix, line_lead, stroke_twin,
//                                     underline_ops, Alignment, LineWriter (stretch, shown, write_line, show_piece, write_all), block_ops,
//                                     shows_before_paragraph, paragraph_style, source_font, rewrite_block_from, reveal_ops
//   crates/edit/src/text/fallback.rs  source_show (words with a TJ gap where the subset has no space), drop_unused_fallback_fonts, source_family
//   crates/edit/src/text/lines.rs     splice (the replaced operators go, the paragraph is inserted before the text object), rewritten_contents
//                                     (changed streams become new streams keeping their dictionaries, the others stay)
// Not translated (docs/spec/patches/folio/edit.json): the styled path (a paragraph of several fonts, sizes or colours is set in its first run's
// style and the result says so), Type 3 / Japanese / Hebrew fallback faces (text those faces draw is refused), right-to-left and Indic reordering,
// selected-row alignment, source_space's search of the page's other fonts of the same family for a space width (0.33 em is used). No DOM, no Node built-ins.

import {PDFName, PDFDict, PDFRef} from 'pdf-lib';
import {serializeContent, mul, at, invert} from './redact-content.mjs';
import {cropOf, freeFontName} from './edit-place.mjs';
import {winAnsiBytes, firstUndrawable} from './fonts.mjs';
import {mk, readPage, paintOps, stateOps, union, lineDirection, lineRotation, lineUpright, frameOrigin, lineWrapLeading, TextError, nameA} from './text-interp.mjs';
import {groupBlocks, wrap, paragraphSeparator, isCentred, alignmentFrame} from './text-blocks.mjs';
import {rewriteStyled} from './text-styled.mjs';
import {Metrics, fontDictOf, sourceFamily, familyBaseFont, stdTextWidth, sameBaseFont} from './text-font.mjs';

const N = s => PDFName.of(s);
const invalid = message => new TextError(message);

/** refuse_clipping_text: text used as a clipping path (`4 Tr` to `7 Tr`) is a mask, not ink. */
export function refuseClippingText(lines, dropped) {
  if (lines.some(l => l.clips && l.ops.some(op => dropped.has(op)))) throw invalid('text used as a clipping path cannot be edited: its glyphs mask the artwork behind them');
}

function overlapsHalf(a, b, area) {
  const ix = Math.max(Math.min(b[2], a[2]) - Math.max(b[0], a[0]), 0);
  const iy = Math.max(Math.min(b[3], a[3]) - Math.max(b[1], a[1]), 0);
  const small = Math.min(area(b), area(a));
  return small > 0 && (ix * iy) / small > 0.5;
}
function onSameBaseline(line, target) {
  const [d, td] = [lineDirection(line), lineDirection(target)];
  const sameDir = Math.abs(d[0] - td[0]) < 1e-3 && Math.abs(d[1] - td[1]) < 1e-3;
  const sameSize = Math.min(line.size, target.size) >= Math.max(line.size, target.size) * 0.8;
  const angle = lineRotation(target) * Math.PI / 180;
  const [sin, cos] = Number.isFinite(angle) ? [Math.sin(angle), Math.cos(angle)] : [0, 1];
  const dx = line.origin.x - target.origin.x, dy = line.origin.baseline - target.origin.baseline;
  const offset = Math.abs(-dx * sin + dy * cos);
  return sameDir && sameSize && Number.isFinite(offset) && offset < Math.max(Math.min(line.size, target.size), 1) * 0.3;
}
/** coincident_ops: the operators of every line that is another drawing of one of `targets` (fake bold, an invisible text layer). */
export function coincidentOps(lines, targets) {
  const area = r => Math.max((r[2] - r[0]) * (r[3] - r[1]), 0);
  const drop = new Set();
  for (const line of lines) {
    const copy = targets.some(t => {
      const sameText = line.text.trim() === t.text.trim() || (line.origin.state.renderMode === 3) !== (t.origin.state.renderMode === 3);
      return sameText && overlapsHalf(line.rect, t.rect, area) && onSameBaseline(line, t);
    });
    if (copy) for (const op of line.ops) drop.add(op);
  }
  return drop;
}

/** paragraph_text: explicit breaks stay, each typed space stays, other white space is one space. */
export function paragraphText(text) {
  return [...text.replace(/\r\n/g, '\n')].map(c => (c === '\r' ? '\n' : c !== '\n' && paragraphSeparator(c) ? ' ' : c)).join('');
}

function marginReach(origin, direction, low, high) {
  if (direction > 1e-6) return (high - 36 - origin) / direction;
  if (direction < -1e-6) return (low + 36 - origin) / direction;
  return Infinity;
}

/** drawn_movement: the move in page space taken back through the CTM's linear part. */
export function drawnMovement(ctm, dx, dy) {
  if (dx === 0 && dy === 0) return null;
  const back = invert([ctm[0], ctm[1], ctm[2], ctm[3], 0, 0]);
  if (!back) throw invalid("the paragraph is drawn in a space it can't be moved in");
  return at(back, dx, dy);
}
/** emit_text_matrix: the paragraph's first text matrix, taken from where its text starts to where it is written. */
export function emitTextMatrix(first, emit) {
  if (first.ctm.every((v, i) => v === emit.ctm[i])) return first.tm;
  const inv = invert(emit.ctm);
  if (!inv) throw invalid('the paragraph has a singular transform');
  return mul(mul(first.tm, first.ctm), inv);
}

/** line_lead: the paragraph's own line spacing (scaled with the size), or 1.2 × the size. */
export function lineLead(block, lines, style, scale) {
  if (style.lineSpacing !== undefined) return scale.size * Math.min(5, Math.max(0.5, style.lineSpacing));
  if (block.rows.length >= 2) {
    const [upper, lower] = [lines[block.rows[0][0]], lines[block.rows[1][0]]];
    return (frameOrigin(upper)[1] - frameOrigin(lower)[1]) / scale.k * scale.size / scale.oldSize;
  }
  return scale.leading > 0 ? scale.leading : scale.size * 1.2;
}

const strokeTwin = fill => mk.op({g: 'G', rg: 'RG', k: 'K', cs: 'CS', sc: 'SC'}[fill.op] ?? 'SCN', ...fill.args);

function underlineOps(fill, tm, size, underlines) {
  const ops = [mk.op('q'), mk.op('cm', ...tm.map(mk.num))];
  ops.push(...fill.map(strokeTwin), mk.op('w', mk.num(size * 0.06)));
  for (const [x0, x1, y] of underlines) ops.push(mk.op('m', mk.num(x0), mk.num(y)), mk.op('l', mk.num(x1), mk.num(y)));
  ops.push(mk.op('S'), mk.op('Q'));
  return ops;
}

/** reveal_ops: the cover (when asked for) and visible rendering that start a rewritten invisible paragraph. */
export function revealOps(block, lines, style, ctm) {
  if (!block.invisible) return [];
  const ops = [];
  if (style.cover) {
    if (style.cover.some(c => !Number.isFinite(c) || c < 0 || c > 1)) throw invalid('the cover colour must be RGB values from 0 to 1');
    const back = invert(ctm);
    if (!back) throw invalid("the paragraph is drawn in a space it can't be covered in");
    ops.push(mk.op('q'), mk.op('rg', ...style.cover.map(mk.num)));
    for (const rect of block.lines.map(i => lines[i].rect)) {
      const pad = Math.min(Math.max(Math.abs(rect[3] - rect[1]) * 0.1, 0.5), 2);
      const corners = [[rect[0] - pad, rect[1] - pad], [rect[2] + pad, rect[1] - pad], [rect[2] + pad, rect[3] + pad], [rect[0] - pad, rect[3] + pad]];
      corners.forEach(([x, y], i) => {
        const [bx, by] = at(back, x, y);
        if (!Number.isFinite(bx) || !Number.isFinite(by)) throw invalid("the paragraph's area can't be covered");
        ops.push(mk.op(i === 0 ? 'm' : 'l', mk.num(bx), mk.num(by)));
      });
      ops.push(mk.op('h'));
    }
    ops.push(mk.op('f'), mk.op('Q'));
  }
  ops.push(mk.op('Tr', mk.num(0)));
  return ops;
}

/** source_show: the text in the source font's own codes; where the subset has no space, each word with a TJ gap between. */
export function sourceShow(metrics, text, size, space, charSpacing, wordSpacing) {
  const whole = metrics.encode(text);
  if (whole) return [mk.op('Tj', mk.str(whole))];
  const adjustment = -1000 * (space + (charSpacing + wordSpacing) / size);
  if (!Number.isFinite(adjustment)) throw invalid("the source font's space advance is invalid");
  const out = [];
  text.split(' ').forEach((word, i) => {
    if (i > 0) out.push(mk.op('TJ', mk.arr([mk.num(adjustment)])));
    if (word) {
      const b = metrics.encode(word);
      if (!b) throw invalid('the source font cannot show the replacement text');
      out.push(mk.op('Tj', mk.str(b)));
    }
  });
  return out;
}

/** shows_before_paragraph: text shown earlier in the same text object stays first. */
export function showsBeforeParagraph(ops, from, to, dropped) {
  for (let i = from; i < to && i < ops.length; i++) if (['Tj', 'TJ', "'", '"'].includes(ops[i].op) && !dropped.has(i)) return true;
  return false;
}

const countSpaces = s => s.split(' ').length - 1;

/** ParaGeometry::width: a paragraph keeps its width (or takes the one asked for); a single line grows to the right up to the page's margin. */
export function paragraphWidth(g, requested) {
  const [left, , right] = g.rect;
  const own = Math.max(right - left, g.size * g.k);
  let width;
  if (requested !== undefined) {
    if (!Number.isFinite(requested)) throw invalid("the paragraph's width must be a number");
    width = Math.min(Math.max(requested, Math.min(g.size * g.k, 14400)), 14400);
  } else if (!g.upright) width = Math.max(g.frame[2] - g.frame[0], g.size * g.k);
  else if (g.singleLine && !g.centred) width = Math.max(own, g.crop[2] - 36 - (left + g.dx));
  else width = own;
  if (!Number.isFinite(width)) throw invalid("the paragraph's width must be a number");
  return width;
}

/** The Helvetica-family stand-in's font dictionary entries. */
export const standInDict = base => ({Type: 'Font', Subtype: 'Type1', BaseFont: base, Encoding: 'WinAnsiEncoding'});

/** Adds (or replaces) font resources in the page's own resources (copied from the inherited ones). */
export function setFonts(doc, page, add, keepName) {
  const ctx = doc.context;
  const inherited = page.node.Resources();
  const res = inherited ? inherited.clone(ctx) : ctx.obj({});
  const f = res.lookup(N('Font'));
  const fonts = f instanceof PDFDict ? f.clone(ctx) : ctx.obj({});
  for (const [name, dict] of add) fonts.set(N(name), ctx.obj(dict));
  for (const key of fonts.keys()) {
    const name = key.decodeText();
    if (name.startsWith('PCEd') && !keepName(name)) fonts.delete(key);
  }
  res.set(N('Font'), fonts);
  page.node.set(N('Resources'), res);
}

/**
 * Splice (lines.rs splice): operators in `dropped` go, `inserts` (operator index → operators) go before that operator. Streams that change become new
 * streams (keeping a /PCMark tag), the others stay; returns the names of the fonts the page's operators still show.
 */
export function writeStreams(doc, page, read, dropped, inserts) {
  const ctx = doc.context;
  const touched = new Set(read.ops.filter((_, i) => dropped.has(i)).map(o => o.stream));
  for (const at of inserts.keys()) touched.add(read.ops[at]?.stream ?? read.ops.at(-1)?.stream ?? 0);
  const perStream = read.streams.map(() => []);
  const used = new Set();
  read.ops.forEach((op, i) => {
    if (inserts.has(i)) for (const x of inserts.get(i)) { perStream[op.stream].push(x); if (x.op === 'Tf') used.add(nameA(x, 0)); }
    if (dropped.has(i)) return;
    perStream[op.stream].push(op);
    if (op.op === 'Tf') used.add(nameA(op, 0));
  });
  const refs = read.streams.map((s, si) => {
    if (!touched.has(si)) return s.ref;
    const old = s.ref instanceof PDFRef ? ctx.lookup(s.ref) : s.ref;
    const extras = {};
    const tag = old?.dict?.get?.(N('PCMark'));
    if (tag instanceof PDFName) extras.PCMark = tag.decodeText();
    return ctx.register(ctx.flateStream(serializeContent(perStream[si]), extras));
  });
  page.node.set(N('Contents'), ctx.obj(refs));
  return used;
}

/** The paragraph's own text state with the style's spacing and scale. */
function paragraphStyle(o, style) {
  if (!o.state.font) throw invalid('the paragraph has no font');
  const [fontName, oldSize] = o.state.font;
  const k = Math.max(o.k, 1e-6);
  const size = style.size !== undefined ? Math.max(style.size / k, 0.1) : oldSize;
  const state = {...o.state, fill: o.state.fill.slice(), stroke: o.state.stroke.slice(), extGState: o.state.extGState.slice()};
  if (style.charSpacing !== undefined) state.charSpacing = style.charSpacing / k;
  if (style.scale !== undefined) state.scale = Math.min(10, Math.max(0.1, style.scale / 100));
  return {fontName, state, size, oldSize, k};
}

/** What a rewrite of a block did (rewrite_block_from's LineEdit, with the reasons the paragraph's own look could not be kept). */
export function rewriteBlock(doc, page, blockIndex, text, style = {}) {
  const read = readPage(doc, page);
  const {lines, ops} = read;
  const blocks = groupBlocks(lines.filter(l => !l.vertical));
  // The block list is of the editable-order lines; `blockIndex` names a block of that list.
  const b = blocks[blockIndex];
  if (!b) throw invalid(`this page has no paragraph ${blockIndex + 1}`);
  return rewriteFrom(doc, page, read, lines.filter(l => !l.vertical), blocks, b, text, style);
}

export function rewriteFrom(doc, page, read, lines, blocks, b, text, style = {}) {
  const {ops} = read;
  if (style.aligns?.some(Boolean)) throw invalid('selected-row alignment of existing paragraphs is not supported until it can be preserved across editing sessions');
  const framed = (() => {
    const frame = alignmentFrame(lines, blocks, b, style, text ?? b.editorText);
    return frame ? {...style, width: frame[1] - frame[0], offset: [frame[0] - b.rect[0], 0]} : style;
  })();
  style = framed;
  const members = b.lines.map(i => lines[i]);
  const first = members[0];
  if (!first) throw invalid('the paragraph has no source runs');
  for (const l of members) if (l.refusal) throw invalid(l.refusal);
  const dropped = coincidentOps(lines, members);
  for (const l of members) for (const op of l.ops) dropped.add(op);
  refuseClippingText(lines, dropped);
  const upright = members.every(lineUpright);
  const resources = read.resources;
  const fontsRes = resources instanceof PDFDict && resources.lookup(N('Font')) instanceof PDFDict ? resources.lookup(N('Font')) : null;
  const mixed = members.some(l => !(l.font === first.font || sameBaseFont(l.baseFont, first.baseFont)) || Math.abs(l.size - first.size) > 0.01 || l.color.some((c, i) => c !== first.color[i]) || l.bold !== first.bold || l.italic !== first.italic);
  // A paragraph of several fonts, sizes or colours keeps each run's style (the styled path), unless a face is asked for.
  if (mixed && upright && style.family === undefined && style.bold === undefined && style.italic === undefined && style.resource === undefined && style.underline !== true && style.align !== 'justify') {
    const styled = rewriteStyled({doc, page, read, lines, b, members, first, style, text, dropped, resources, fontsRes});
    if (styled) return styled;
  }
  const para = paragraphText(text ?? b.text);
  if (/[֐-ࣿיִ-﷿ﹰ-﻿]/.test(para)) throw invalid("right-to-left text isn't written here yet");
  const flat = para.replace(/\n/g, ' ');
  const o = first.origin;
  const last = members.at(-1);
  const emit = last.origin;
  const {fontName: ownFont, state: oState, size, oldSize, k} = paragraphStyle(o, style);
  let fontName = style.resource ?? ownFont;
  const metricsOf = name => {
    const dict = fontDictOf(doc.context, resources, name);
    if (!dict) return null;
    try { return Metrics.fromDict(doc.context, dict); } catch { return null; }
  };
  const sourceMetrics = metricsOf(fontName);
  if (style.resource && !(sourceMetrics && sourceMetrics.encodes(flat))) throw invalid(`the font ${style.resource} can't show this text`);
  const reuse = style.family === undefined && style.bold === undefined && style.italic === undefined && !!sourceMetrics && sourceMetrics.encodes(flat);
  const space = sourceMetrics ? sourceMetrics.space() : 0.33;
  const sourceFamilyName = sourceFamily(b.baseFont);
  const family = style.family ?? sourceFamilyName;
  const bold = style.bold ?? b.bold;
  const italic = style.italic ?? b.italic;
  const [dx, dy] = style.offset ?? [0, 0];
  if (!(Number.isFinite(dx) && Number.isFinite(dy))) throw invalid("the paragraph can't be moved that far");
  const frame = upright ? b.rect : members.map(l => l.frame).reduce(union);
  const crop = cropOf(page);
  const centred = upright && style.width === undefined && style.align === undefined && isCentred(b, lines, (crop[0] + crop[2]) / 2, first.size);
  const geometry = {rect: b.rect, frame, crop, upright, k, size, dx, singleLine: members.length === 1, centred};
  let width = paragraphWidth(geometry, style.width);
  const align = centred ? 'center' : style.align;
  const movement = drawnMovement(emit.ctm, dx, dy);
  const tm = emitTextMatrix(o, emit);
  const base = familyBaseFont(family, bold, italic);
  const sourceUsed = reuse ? sourceMetrics : null;
  const advance = {of: s => {
    const extra = [...s].length * oState.charSpacing;
    const t = sourceUsed ? sourceUsed.textWidth(s, size, space, oState.charSpacing, oState.wordSpacing) : stdTextWidth(base, s, size) + extra;
    return t * oState.scale * k;
  }};
  if (!upright && style.width === undefined && members.length === 1) {
    const [x0, y0] = [first.origin.x + dx, first.origin.baseline + dy];
    const [ux, uy] = lineDirection(first);
    const cap = Math.min(Math.max(width, Math.min(marginReach(x0, ux, crop[0], crop[2]), marginReach(y0, uy, crop[1], crop[3]))), 14400);
    width = Math.min(para.split('\n').map(l => advance.of(l)).reduce((a, c) => Math.max(a, c), width), cap);
  }
  const wrapped = wrap(para, width + 0.5, advance.of);
  // The font the paragraph is shown in.
  let showFont, encode, substituted = null;
  const addFonts = [];
  if (sourceUsed) {
    showFont = fontName;
    encode = s => { const bytes = sourceUsed.encode(s); return bytes ? [[fontName, bytes]] : null; };
  } else {
    const bad = firstUndrawable(flat);
    if (bad !== null) throw invalid(`"${flat}" has characters neither ${b.baseFont || 'the font'} nor ${base} can show`);
    const preferred = `PCEd${base.replace(/-/g, '')}`;
    const existing = fontsRes ?? doc.context.obj({});
    const name = freeFontName(doc, existing, preferred, base);
    addFonts.push([name, standInDict(base)]);
    showFont = name;
    encode = s => [[name, Uint8Array.from(winAnsiBytes(s))]];
    substituted = style.family === undefined && style.bold === undefined && style.italic === undefined ? base : null;
  }
  const lead = lineLead(b, lines, style, {k, size, oldSize, leading: oState.leading});
  const start = last.ops[0] ?? emit.btOp;
  const split = showsBeforeParagraph(ops, emit.btOp, start, dropped);
  const after = split ? emit.state : emit.btState;
  const wsReaches = sourceUsed ? (() => { const bytes = sourceUsed.encode(' '); return !!bytes && sourceUsed.codes(bytes).every(c => sourceUsed.isSpace(c.code, c.len)); })() : true;
  // Writing the lines.
  const n = mk.num;
  const writeLine = (index, line, [row, soft, gap], isLast, cursor, out) => {
    const lineAlign = align;
    void row;
    const body = line.replace(/^ +| +$/g, '');
    const interior = countSpaces(body);
    let tw = 0;
    if (lineAlign === 'justify' && !isLast && interior > 0 && Math.abs(oState.scale) > 1e-6) {
      const v = Math.max(width - advance.of(body), 0) / k / oState.scale / interior;
      tw = Number.isFinite(v) ? v : 0;
    }
    const [shown, visible] = tw > 0 ? [body, advance.of(body)] : [line, advance.of(line.replace(/ +$/, ''))];
    const free = Math.max(width - visible, 0) / k;
    const dxl = tw > 0 ? 0 : lineAlign === 'center' ? free / 2 : lineAlign === 'right' ? free : 0;
    if (index > 0) {
      if (soft) out.push(mk.op('BDC', mk.name('PCSoft'), mk.dict([['N', n(gap)]])));
      else out.push(mk.op('BMC', mk.name('PCHard')));
      out.push(mk.op('EMC'));
    }
    if (index > 0 || dxl !== 0) out.push(mk.op('Td', n(dxl - cursor.x), n(index > 0 ? -lead : 0)));
    cursor.x = dxl;
    const stretch = wsReaches ? 0 : tw;
    tw -= stretch;
    if (tw !== cursor.twSet) { out.push(mk.op('Tw', n(tw))); cursor.twSet = tw; }
    const pieces = stretch > 0 ? (shown === '' ? [] : shown.split(/(?<= )/)) : [shown];
    for (const piece of pieces) {
      if (sourceUsed) out.push(...sourceShow(sourceUsed, piece, size, space, oState.charSpacing, tw));
      else {
        const runs = encode(piece);
        if (!runs) throw invalid(`"${line}" can't be shown`);
        for (const [font, bytes] of runs) {
          if (font !== cursor.shownFont) { out.push(mk.op('Tf', mk.name(font), n(size))); cursor.shownFont = font; }
          out.push(mk.op('Tj', mk.str(bytes)));
        }
      }
      if (stretch > 0 && piece.endsWith(' ')) out.push(mk.op('TJ', mk.arr([n(-1000 * stretch / size)])));
    }
    const total = tw + stretch;
    const w = (visible + total * interior * oState.scale * k) / k;
    return [dxl, dxl + w, -index * lead - size * 0.12];
  };
  const out = [mk.op('q'), ...revealOps(b, lines, style, emit.ctm)];
  if (movement) out.push(mk.op('cm', n(1), n(0), n(0), n(1), n(movement[0]), n(movement[1])));
  out.push(...paintOps(oState, after));
  out.push(mk.op('BT'));
  const state = {...oState, wordSpacing: 0, font: [showFont, size]};
  if (style.color) state.fill = [mk.op('rg', ...style.color.map(n))];
  out.push(...stateOps(state), mk.op('Tm', ...tm.map(n)));
  const cursor = {x: 0, twSet: 0, shownFont: showFont};
  const underlines = [];
  let rowNo = 0;
  wrapped.forEach(([line, soft, gap], i) => {
    if (i > 0 && !soft) rowNo++;
    underlines.push(writeLine(i, line, [rowNo, soft, gap], i + 1 === wrapped.length, cursor, out));
  });
  out.push(mk.op('ET'));
  if (style.underline === true) out.push(...underlineOps(state.fill, tm, size, underlines));
  out.push(mk.op('Q'));
  out.push(...stateOps(after).filter(op => op.op !== 'Tf' || after.font));
  if (split) { out.unshift(mk.op('ET')); out.push(mk.op('BT'), mk.op('Tm', ...emit.tlm.map(n))); }
  const insertAt = split ? start : emit.btOp;
  const used = writeStreams(doc, page, read, dropped, new Map([[insertAt, out]]));
  if (addFonts.length || [...(fontsRes?.keys() ?? [])].some(key => key.decodeText().startsWith('PCEd'))) {
    for (const [name] of addFonts) used.add(name);
    setFonts(doc, page, addFonts, name => used.has(name));
  }
  return {substituted, flattened: mixed, rows: wrapped.length};
}

export {readPage};

/**
 * translate_blocks: move paragraphs together without re-encoding glyphs, changing fonts or reflowing. A numeric TJ offset and the text rise move each
 * show operator, then restore both, so the reader advances the original glyph bytes itself and text positioned after them stays where it was (§9.4.4).
 * `offset` is [dx, dy] in the page's user space.
 */
export function translateBlocks(doc, page, read, lines, blocks, indexes, offset) {
  if (!indexes.length) return {moved: 0};
  const selected = new Set();
  for (const index of indexes) {
    const b = blocks[index];
    if (!b) throw invalid('a selected paragraph no longer exists');
    for (const i of b.lines) {
      const l = lines[i];
      if (l.refusal) throw invalid(l.refusal);
      for (const op of l.ops) selected.add(op);
    }
  }
  const patches = new Map();
  for (const s of read.shown.filter(x => selected.has(x.op))) {
    if (!(s.state.renderMode >= 0 && s.state.renderMode <= 3)) throw invalid('text used as a clipping path cannot be moved in a group');
    const inverse = invert(mul(s.tm, s.state.ctm));
    if (!inverse) throw invalid('a selected paragraph has no area');
    const [a, b, c, d] = inverse;
    const [dx, dy] = [a * offset[0] + c * offset[1], b * offset[0] + d * offset[1]];
    const denominator = s.state.size * s.state.scale;
    let shift;
    if (dx === 0) shift = 0;
    else if (Math.abs(denominator) > 1e-12) shift = -1000 * dx / denominator;
    else throw invalid('a selected paragraph has no horizontal advance');
    const rise = s.state.rise + dy;
    if (![shift, rise, dx, dy].every(v => Number.isFinite(v) && Math.abs(v) <= 1e12)) throw invalid('the paragraph move is too large');
    const original = read.ops[s.op];
    const replacement = [];
    let show;
    if (original.op === "'" || original.op === '"') {
      if (original.op === '"') {
        const spacing = original.args.slice(0, 2);
        if (spacing.length < 2 || !spacing.every(x => x.k === 'num')) throw invalid('a text operation has invalid spacing');
        replacement.push(mk.op('Tw', spacing[0]), mk.op('Tc', spacing[1]));
      }
      replacement.push(mk.op('T*'));
      const str = original.args.at(-1);
      if (!str) throw invalid('a text operation has no string');
      show = mk.op('Tj', str);
    } else show = original;
    if (dy !== 0) replacement.push(mk.op('Ts', mk.num(rise)));
    if (shift !== 0) replacement.push(mk.op('TJ', mk.arr([mk.num(shift)])));
    replacement.push(show);
    if (shift !== 0) replacement.push(mk.op('TJ', mk.arr([mk.num(-shift)])));
    if (dy !== 0) replacement.push(mk.op('Ts', mk.num(s.state.rise)));
    patches.set(s.op, replacement);
  }
  if (patches.size !== selected.size) throw invalid('a selected text operation cannot be moved');
  writeStreams(doc, page, read, new Set(patches.keys()), patches);
  return {moved: patches.size};
}
