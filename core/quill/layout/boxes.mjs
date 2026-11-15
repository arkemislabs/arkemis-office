// A story laid out in a box (header, footer, note, cell, text box): paragraphs stacked with their
// spacing, borders and shading, tables, floats; and `pushPara`, which places a paragraph's lines
// with its shading and borders.
//
// Translated from wordcraft crates/layout/src/boxes.rs (ArtCraft commit
// aadb077e072b7de05f724e359d8db82e151f125c). Not translated: text frames (`w:framePr`, laid out
// as ordinary paragraphs here), floating tables inside boxes (laid out in the flow).
import {borderVisible} from '../model/props.mjs';
import {floatRect, floating, leftOutObjects, placeObjects, relExclusions, wrapAreas} from './floats.mjs';
import {rect} from './placed.mjs';

/** Paragraphs with the same borders join in one box (border_group / joined). */
export function joined(ctx, blocks, i, j, tablePara = null) {
  const a = blocks[i], b = j === null || j < 0 ? null : blocks[j];
  if (!a || !b || a.kind !== 'para' || b.kind !== 'para') return false;
  const ra = ctx.doc.resolvePara(a.props, tablePara), rb = ctx.doc.resolvePara(b.props, tablePara);
  return !!ra.borders && JSON.stringify(ra.borders) === JSON.stringify(rb.borders) && ra.indentLeft === rb.indentLeft && ra.indentRight === rb.indentRight;
}

/** The room a paragraph's top or bottom border takes (border_room). */
export const borderRoom = b => (borderVisible(b) ? (b.space ?? 0) + b.width : 0);

/** A paragraph's own edges (Edges::own). */
export function ownEdges(pl, l0, l1) {
  const b = pl.rp.borders ?? {};
  return {top: l0 === 0 ? borderRoom(b.top) : 0, bottom: l1 >= pl.lines.length ? borderRoom(b.bottom) : 0, up: 0};
}

/** Paragraph lines plus their shading and borders; returns the bottom of the lines (push_para). */
export function pushPara(items, story, path, pl, l0, l1, x, y, width, e) {
  const first = pl.lines[l0], last = pl.lines[l1 - 1];
  if (!first || !last) return y;
  const h = last.top + last.height - first.top;
  const rp = pl.rp;
  const start = Math.min(rp.indentLeft, rp.indentLeft + rp.indentFirst);
  const [li, ri] = rp.bidi ? [rp.indentRight, start] : [start, rp.indentRight];
  const left = x + li, right = x + width - ri;
  const top = y - e.top - e.up, bottom = y + h + e.bottom;
  if (rp.shading) {
    const color = shadingColor(rp.shading);
    if (color) {
      const pad = rp.borders ? rp.borders.left?.space ?? 4 : 0;
      items.push({kind: 'fill', rect: rect(left - pad, top, right - left + pad * 2, bottom - top), color});
    }
  }
  items.push({kind: 'lines', story, path, para: pl, l0, l1, x, y});
  const b = rp.borders;
  if (b) {
    const sp = o => o?.space ?? 0;
    const lx = left - sp(b.left), rx = right + sp(b.right);
    if (e.top > 0 && borderVisible(b.top)) { const ty = y - b.top.space - b.top.width / 2; items.push({kind: 'rule', x0: lx, y0: ty, x1: rx, y1: ty, border: b.top}); }
    if (e.bottom > 0 && borderVisible(b.bottom)) { const by = y + h + b.bottom.space + b.bottom.width / 2; items.push({kind: 'rule', x0: lx, y0: by, x1: rx, y1: by, border: b.bottom}); }
    if (borderVisible(b.left)) items.push({kind: 'rule', x0: lx, y0: top, x1: lx, y1: bottom, border: b.left});
    if (borderVisible(b.right)) items.push({kind: 'rule', x0: rx, y0: top, x1: rx, y1: bottom, border: b.right});
  }
  return y + h;
}

/** A shading's fill colour ([r, g, b]) or null: an Rgb, or {fill} as the model keeps cell/paragraph shading. */
export function shadingColor(s) {
  if (!s) return null;
  if (Array.isArray(s)) return s;
  if (Array.isArray(s.fill)) return s.fill;
  if (Array.isArray(s.color)) return s.color;
  return null;
}

/** The spacing before a paragraph in a box (paragraph_spacing): [contextual, before], adjusting `st`. */
function paragraphSpacing(i, listed, rp, st, sum) {
  let before = rp.spaceBefore;
  const contextual = rp.contextualSpacing;
  if (st.prevStyle && st.prevStyle[0] === rp.style) {
    if (st.prevStyle[1]) { st.y -= st.prevAfter; before = Math.max(before - st.prevAfter, 0); st.prevAfter = 0; }
    if (contextual) before = 0;
  }
  if (i > 0 && st.prevListed && listed) {
    if (st.prevAfterAuto) { st.y -= st.prevAfter; st.prevAfter = 0; }
    if (rp.beforeAuto) before = 0;
  }
  if (rp.beforeAuto && i === 0) before = 0;
  else if (i > 0 && before > 0 && st.prevAfter > 0 && !sum) before = Math.max(before - st.prevAfter, 0);
  return [contextual, before];
}

/**
 * Lay a story out in a box `width` wide (layout_box). `input`: {story, blocks, prefix, width,
 * cell (CellText, or undefined outside cells), depth, frame}. Returns {items, height, floatsBottom, lastTop}.
 */
export function layoutBox(ctx, input) {
  const {story, blocks, prefix = [], width, cell, depth = 0, frame = null} = input;
  const outerHide = ctx.hideDeleted;
  ctx.hideDeleted = hidesFor(ctx.opts, story);
  const inCell = cell !== undefined;
  const table = inCell ? cell ?? EMPTY_CELL : null;
  let items = [];
  let behind = 0;
  const excl = [];
  let floatsBottom = 0, lastTop = 0, prevEnd = 0;
  const st = {y: 0, prevAfter: 0, prevAfterAuto: false, prevListed: false, prevStyle: null};
  const sum = !!ctx.doc.settings.sumParagraphSpacing;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    lastTop = st.y;
    const path = prefix.concat([i]);
    if (b.kind === 'table') {
      // A table in a box: its rows one after another (table.rs layout_table), in the flow.
      const tl = ctx.layoutTable(story, b, path, width, depth + 1);
      st.y += 0;
      for (const row of tl.rows) {
        for (const it of row.items) items.push(shift({...it}, tl.x, st.y));
        st.y += row.height;
      }
      st.prevAfter = 0;
      st.prevStyle = null;
      continue;
    }
    const p = b;
    const label = ctx.nextLabel(p);
    const listed = !!label;
    let pl = ctx.paraLabelled(p, width, table, [], label);
    const [ctxl, before] = paragraphSpacing(i, listed, pl.rp, st, sum);
    const paraTop = st.y;
    st.y += i === 0 ? before : Math.max(before, 0);
    const floats = new Map();
    if (p.objects?.length) {
      const out = leftOutObjects(ctx.doc, p, table?.chr ?? null, !!ctx.opts.showHidden, ctx.hideDeleted);
      p.objects.forEach((o, oi) => {
        const fl = floating(o);
        if (!fl || out(oi)) return;
        const [w, h, f] = fl;
        const fy = f.vRel === 'paragraph' ? paraTop : st.y;
        const r = floatRect(frame, [0, width], fy, w, h, f);
        excl.push(...wrapAreas(r, f, o));
        floats.set(oi, r);
      });
    }
    const rel = relExclusions(excl, 0, st.y);
    if (rel.length) pl = ctx.paraLabelled(p, width, table, rel, label);
    const above = joined(ctx, blocks, i, i - 1, table?.para ?? null), below = joined(ctx, blocks, i, i + 1, table?.para ?? null);
    const edges = ownEdges(pl, 0, pl.lines.length);
    if (above) edges.top = 0;
    if (below) edges.bottom = 0;
    const lead = Math.max(pl.lines[0]?.top ?? 0, 0) + edges.top;
    if (above) edges.up = Math.max(st.y + lead - prevEnd, 0);
    prevEnd = pushPara(items, story, path, pl, 0, pl.lines.length, 0, st.y + lead, width, edges);
    if (p.objects?.length) {
      const [back, front] = placeObjects(ctx, {story, path, p, pl, lines: [0, pl.lines.length], origin: [0, st.y + lead], floats, depth});
      for (const it of back.concat(front)) {
        if (it.kind === 'object' && !['inline', 'behindText', 'inFrontOfText'].includes(it.wrap)) floatsBottom = Math.max(floatsBottom, it.rect.y + it.rect.h);
      }
      items.splice(Math.min(behind, items.length), 0, ...back);
      behind += back.length;
      items.push(...front);
    }
    const after = pl.rp.afterAuto && i + 1 === blocks.length ? 0 : pl.rp.spaceAfter;
    st.y += edges.top + pl.height + edges.bottom + after;
    st.prevAfter = after;
    st.prevAfterAuto = pl.rp.afterAuto;
    st.prevListed = listed;
    st.prevStyle = [pl.rp.style, ctxl];
  }
  ctx.hideDeleted = outerHide;
  return {items, height: Math.max(st.y, 0), floatsBottom, lastTop: Math.max(lastTop, 0)};
}

const EMPTY_CELL = Object.freeze({para: null, chr: null});
function shift(it, dx, dy) {
  if (it.kind === 'lines') { it.x += dx; it.y += dy; } else if (it.kind === 'rule') { it.x0 += dx; it.x1 += dx; it.y0 += dy; it.y1 += dy; } else if (it.rect) it.rect = {...it.rect, x: it.rect.x + dx, y: it.rect.y + dy};
  if (it.origin) it.origin = {x: it.origin.x + dx, y: it.origin.y + dy};
  return it;
}
function hidesFor(opts, story) {
  const inserted = !!opts.hideInserted;
  if (opts.hideDeleted || (opts.deletionsInBalloons && story === 'body')) return {plain: true, movedFrom: true, inserted};
  return {plain: !!opts.hideMarked?.plain, movedFrom: !!opts.hideMarked?.movedFrom, inserted};
}
