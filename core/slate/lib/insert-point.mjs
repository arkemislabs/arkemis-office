// Where an Insert command puts its content (U:slate/insert).
//
// Slate has no ArtCraft upstream; OneNote's behaviour: an inserted object goes where the caret is
// in a note; with no caret in a note (the page, its title, a selected container) it goes in a note
// container of its own on the page. Text-like items (symbols, date and time stamps, links) replace
// the selected text as typing would; objects (pictures, files, equations) go at the end of the
// selection. A block (a table) splits the paragraph at the caret and always leaves a paragraph
// after it, so there is somewhere to type.
//
// Everything is one ProseMirror transform applied through the foundation's `steps` op.
//
// No DOM, no Node built-ins.

import {Fragment} from '@tiptap/pm/model';
import {CommandError} from '../../kernel/errors.mjs';
import {isNotebook, nodeOf, schema} from '../schema.mjs';
import {currentLocation} from '../model/notebook.mjs';
import {blockIndex, containersOf, posToPoint} from '../model/page.mjs';
import {insertContainer} from '../model/canvas.mjs';
import {editPage, textRange} from './format-text.mjs';
import {drawDiagram} from './diagram.mjs';

export const bid = (ctx, prefix = 'b') => `${prefix}${ctx.host.uid()}`;
export const emptyParagraph = ctx => schema.nodes.paragraph.create({id: bid(ctx)});

/** The page the command acts on (the selection's) or a `disabled` error. */
export function needPage(ctx) {
  if (!isNotebook(ctx.doc)) throw new CommandError('disabled', 'No notebook is open');
  const {pageId} = currentLocation(ctx.doc, ctx.selection);
  if (!pageId || !ctx.doc.pages[pageId]) throw new CommandError('disabled', 'No page is open');
  return pageId;
}

/** State helper: enabled on a page of a notebook. */
export function pageReady(ctx) {
  if (!isNotebook(ctx.doc)) return {enabled: false, reason: 'No notebook is open'};
  const {pageId} = currentLocation(ctx.doc, ctx.selection);
  return pageId && ctx.doc.pages[pageId] ? {enabled: true} : {enabled: false, reason: 'No page is open'};
}

/** Address of a caret at a document position (in the textblock that holds it). */
export function caretAddress(pageId, doc, pos) {
  const p = posToPoint(doc, pos);
  return p ? `/pg:${pageId}/b:${p.blockId}/t:${p.offset}` : `/pg:${pageId}`;
}

export const caretSelection = (pageId, doc, pos) => {
  const a = caretAddress(pageId, doc, pos);
  return {ranges: [{anchor: a, focus: a}], primary: 0};
};

const LINE = 20;
/** The size (px) an inline object takes on a line: a picture at its own size (no wider than the note), a worksheet, a diagram, a recording, a file. */
function objectSize(n, room) {
  const a = n.attrs;
  switch (n.type.name) {
    case 'image': {
      const w = Math.max(1, Number(a.width) || 100), h = Math.max(1, Number(a.height) || 100);
      const s = Math.min(1, room / w);
      return {w: w * s, h: h * s};
    }
    case 'spreadsheet': return {w: 30 + a.cols * 80, h: 28 + a.rows * 24 + 28};
    case 'diagram': { const d = drawDiagram(a.kind, a.text); return {w: d.width + 14, h: d.height + 14}; }
    case 'media': return a.kind === 'video' ? {w: 320, h: 200} : {w: 300, h: 40};
    case 'attachment': return {w: 200, h: 26};
    case 'equation': return {w: Math.max(40, String(a.linear ?? '').length * 8), h: 28};
    default: return {w: 8, h: LINE};
  }
}

/** The height (px) of a paragraph: lines, each as tall as its tallest inline object (a line wraps when its objects and text pass the note's width). */
function textblockHeight(node, room) {
  let total = 0, lineH = LINE, x = 0;
  node.forEach(child => {
    if (child.type.name === 'hardBreak') { total += lineH; lineH = LINE; x = 0; return; }
    const size = child.isText ? {w: child.text.length * 6.5, h: LINE} : objectSize(child, room);
    if (x > 0 && x + size.w > room) { total += lineH; lineH = LINE; x = 0; }
    x += size.w;
    lineH = Math.max(lineH, size.h + (child.isText ? 0 : 4));
  });
  return total + lineH + 4;
}

/** The height (px) of a block (a paragraph, list, table), as the renderer lays it out: blocks follow each other, a table is its rows, a row its tallest cell. */
function blockHeight(node, room) {
  const t = node.type.name;
  if (node.isTextblock) return textblockHeight(node, room);
  if (t === 'table') {
    let h = 4;
    node.forEach(row => {
      const cells = row.childCount || 1;
      let tall = 26;
      row.forEach(cell => { let c = 6; cell.forEach(b => { c += blockHeight(b, Math.max(48, room / cells - 14)); }); tall = Math.max(tall, c); });
      h += tall;
    });
    return h;
  }
  let h = 0;
  node.forEach(child => { h += blockHeight(child, t === 'bulletList' || t === 'orderedList' || t === 'listItem' ? room - 24 : room); });
  return h;
}

/** A height (px) of a container, to put the next one below it (the renderer lays the note out: this follows its rules, with objects as tall as they are drawn). */
export function estimatedHeight(c) {
  const room = Math.max(48, (c.width ?? c.node.attrs.width ?? 624) - 14);
  let h = 8;
  c.node.forEach(block => { h += blockHeight(block, room); });
  return h;
}
const estimatedBottom = c => c.y + estimatedHeight(c);

/** A free spot for a new container: left margin, below the lowest note (or under the title). */
export function freeSpot(doc) {
  const list = containersOf(doc);
  if (!list.length) return {x: 48, y: 130};
  return {x: 48, y: Math.round(Math.max(...list.map(estimatedBottom)) + 24)};
}

/**
 * Resolve the insertion point: {pageId, doc, range} where range is the text range of the
 * selection (kind 'text', 'container', 'node') or null when the selection holds no note text.
 */
export function pointOf(ctx) {
  const pageId = needPage(ctx);
  const range = textRange(ctx);
  if (range && range.pageId !== pageId) return {pageId, doc: nodeOf(ctx.doc.pages[pageId].body), range: null};
  return {pageId, doc: range?.doc ?? nodeOf(ctx.doc.pages[pageId].body), range};
}

/** The textblock position a point inserts into: the end of a container's last textblock, or a text/node position. */
function inlineTarget(doc, range) {
  if (!range) return null;
  if (range.kind === 'text') {
    const $to = doc.resolve(range.to);
    const $from = doc.resolve(range.from);
    if ($to.parent.isTextblock && $from.parent === $to.parent) return {from: range.from, to: range.to};
    if ($to.parent.isTextblock) return {from: range.to, to: range.to};
    return null;
  }
  if (range.kind === 'node') {
    const $t = doc.resolve(range.to);
    return $t.parent.isTextblock ? {from: range.to, to: range.to} : null;
  }
  // A selected container: the end of its last textblock.
  let last = null;
  doc.nodesBetween(range.from, range.to, (node, pos) => { if (node.isTextblock) last = pos + 1 + node.content.size; return true; });
  return last === null ? null : {from: last, to: last};
}

/**
 * Insert inline nodes (text, a picture, an equation) at the point. `replace` deletes the selected
 * text first (typing); otherwise the nodes go at the end of the selection. Returns
 * {pageId, pos, size, nodes} with pos the position of the first inserted node in the new page doc.
 * With no note to put them in, a new container is started.
 */
export function insertInline(ctx, makeNodes, {replace = false, x, y} = {}) {
  const {pageId, doc, range} = pointOf(ctx);
  const at = inlineTarget(doc, range);
  if (at) {
    let pos = at.from;
    const nodes = makeNodes(doc.resolve(at.from).marks());
    editPage(ctx, pageId, tr => {
      const from = replace ? at.from : at.to, to = replace ? at.to : at.to;
      pos = from;
      tr.replaceWith(from, to, Fragment.from(nodes));
    }, doc);
    return {pageId, pos, size: Fragment.from(nodes).size, nodes};
  }
  // A new note container holding the content.
  const spot = freeSpot(doc);
  const nodes = makeNodes([]);
  const cid = bid(ctx, 'c');
  const para = schema.nodes.paragraph.create({id: bid(ctx)}, Fragment.from(nodes));
  const container = schema.nodes.container.create({id: cid, x: Math.round(x ?? spot.x), y: Math.round(y ?? spot.y), width: null}, para);
  const end = doc.content.size;
  editPage(ctx, pageId, tr => { tr.insert(end, container); }, doc);
  return {pageId, pos: end + 2, size: Fragment.from(nodes).size, nodes};
}

/**
 * Insert a block (a table) at the point. A caret in the middle of a paragraph splits it; at its
 * start the block goes before, at its end (or in an empty paragraph, which stays after the
 * block) after. A paragraph follows the block when it would be the last of its parent. Returns
 * {pageId, pos} of the block in the new page doc.
 */
export function insertBlock(ctx, nodeOrNodes, {x, y} = {}) {
  const {pageId, doc, range} = pointOf(ctx);
  const nodes = Array.isArray(nodeOrNodes) ? nodeOrNodes : [nodeOrNodes];
  const size = Fragment.from(nodes).size;
  const at = inlineTarget(doc, range);
  let pos;
  if (at) {
    editPage(ctx, pageId, tr => {
      const $p = tr.doc.resolve(at.to);
      const textblock = $p.parent;
      let blockPos;
      const start = $p.before();
      if ($p.parentOffset === 0) blockPos = start;
      else if ($p.parentOffset === textblock.content.size) blockPos = start + textblock.nodeSize;
      else { tr.split(at.to); blockPos = start + $p.parentOffset + 2; }
      // A list item or other wrapper: put the block after the textblock inside its own parent.
      tr.insert(blockPos, nodes);
      pos = blockPos;
      const $b = tr.doc.resolve(blockPos);
      const parent = $b.parent;
      if ($b.index() + nodes.length >= parent.childCount) tr.insert(blockPos + size, emptyParagraph(ctx));
    }, doc);
    return {pageId, pos};
  }
  const spot = freeSpot(doc);
  const cid = bid(ctx, 'c');
  const container = schema.nodes.container.create({id: cid, x: Math.round(x ?? spot.x), y: Math.round(y ?? spot.y), width: null}, [...nodes, emptyParagraph(ctx)]);
  const end = doc.content.size;
  editPage(ctx, pageId, tr => { tr.insert(end, container); }, doc);
  return {pageId, pos: end + 1};
}

export {insertContainer, blockIndex};
