// Page bodies: block lookup, text offsets and ProseMirror positions (F:slate foundation).
//
// Slate has no ArtCraft upstream; addresses follow docs/architecture.md 14.6: inside a page, block
// ids are ProseMirror node attrs, text offsets are UTF-16 code units over a textblock's text with
// every inline leaf (picture, attachment, equation, hard break) counted as one U+FFFC. Because a
// ProseMirror text node has one position per code unit and an inline leaf has size one, the
// offset inside a textblock is exactly `pos - start` of that textblock.
//
// No DOM, no Node built-ins.

import {CommandError} from '../../kernel/errors.mjs';
import {assertCodeUnitBoundary} from '../../kernel/address.mjs';
import {ID_NODES, OBJECT_CHAR, nodeOf, schema} from '../schema.mjs';

const indexCache = new WeakMap();

/**
 * Every id-carrying node of a page doc: Map id -> {node, pos, container, parent}. `pos` is the
 * position before the node; `container` the id of the note container it sits in; `parent` the id
 * of the nearest id-carrying ancestor (null at container level). Cached per doc.
 */
export function blockIndex(doc) {
  let index = indexCache.get(doc);
  if (index) return index;
  index = new Map();
  const walk = (node, offset, container, parent) => {
    node.forEach((child, childOffset) => {
      const pos = offset + childOffset;
      let nextContainer = container, nextParent = parent;
      if (ID_NODES.has(child.type.name)) {
        const own = child.attrs.id;
        index.set(own, {node: child, pos, container: child.type.name === 'container' ? own : container, parent});
        if (child.type.name === 'container') nextContainer = own;
        nextParent = own;
      }
      if (!child.isLeaf) walk(child, pos + 1, nextContainer, nextParent);
    });
  };
  walk(doc, 0, null, null);
  indexCache.set(doc, index);
  return index;
}

/** The text of a textblock (inline leaves as U+FFFC). */
export function textOf(node) {
  if (node.isText) return node.text;
  if (node.isInline) return node.isLeaf ? OBJECT_CHAR : node.textContent;
  if (node.isTextblock) {
    let out = '';
    node.forEach(child => { out += child.isText ? child.text : OBJECT_CHAR; });
    return out;
  }
  const parts = [];
  node.forEach(child => parts.push(textOf(child)));
  return parts.join('\n');
}

/** Runs of a textblock: [{text, marks: {bold: true, textStyle: {...}}, object?}]. */
export function runsOf(node) {
  const runs = [];
  node.forEach(child => {
    const marks = Object.fromEntries(child.marks.map(m => [m.type.name, Object.keys(m.attrs).length ? {...m.attrs} : true]));
    if (child.isText) runs.push({text: child.text, marks});
    else runs.push({text: OBJECT_CHAR, marks, object: {type: child.type.name, ...child.attrs}});
  });
  return runs;
}

export function findBlock(doc, blockId, address) {
  const hit = blockIndex(doc).get(blockId);
  if (!hit) throw new CommandError('not_found', `No block ${blockId} on this page`, {address});
  return hit;
}

/** Document position of a text offset in a textblock. Refuses offsets that split a surrogate pair. */
export function pointToPos(doc, blockId, offset, address) {
  const {node, pos} = findBlock(doc, blockId, address);
  if (!node.isTextblock) throw new CommandError('invalid_address', `Block ${blockId} is a ${node.type.name}, not a paragraph: it has no text offsets`, {address});
  assertCodeUnitBoundary(textOf(node), offset);
  return pos + 1 + offset;
}

/**
 * The text point at a document position: {blockId, offset} in the textblock that holds it, or the
 * nearest textblock (a position between blocks snaps into the next one, else the previous).
 */
export function posToPoint(doc, pos) {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  if ($pos.parent.isTextblock && $pos.parent.attrs.id) return {blockId: $pos.parent.attrs.id, offset: $pos.parentOffset};
  let found = null;
  doc.nodesBetween(clamped, doc.content.size, (node, at) => {
    if (found) return false;
    if (node.isTextblock) { found = {blockId: node.attrs.id, offset: 0}; return false; }
    return true;
  });
  if (found) return found;
  doc.nodesBetween(0, clamped, (node, at) => {
    if (node.isTextblock) found = {blockId: node.attrs.id, offset: node.content.size};
    return true;
  });
  return found;
}

/** The note container (node and position) with this id. */
export function findContainer(doc, containerId, address) {
  const hit = blockIndex(doc).get(containerId);
  if (!hit || hit.node.type.name !== 'container') throw new CommandError('not_found', `No note container ${containerId} on this page`, {address});
  return hit;
}

/** Containers in document (z) order: [{id, x, y, width, pos, node}]. */
export function containersOf(doc) {
  const out = [];
  doc.forEach((node, pos) => out.push({id: node.attrs.id, x: node.attrs.x, y: node.attrs.y, width: node.attrs.width, pos, node}));
  return out;
}

/** A paragraph node holding plain text (lines split on \n become paragraphs). */
export function paragraphsFromText(text, newId) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  return lines.map(line => schema.nodes.paragraph.create({id: newId()}, line ? schema.text(line) : null));
}

/** A new note container node with the given text (an empty paragraph when there is none). */
export function containerNode({id, x, y, width = null, text = ''}, newId) {
  return schema.nodes.container.create({id, x, y, width}, paragraphsFromText(text, newId));
}

/** Plain text of a whole page: title, then each container's paragraphs. */
export function pageText(page) {
  const doc = nodeOf(page.body);
  const parts = [page.title];
  doc.forEach(c => parts.push(textOf(c)));
  return parts.filter(Boolean).join('\n');
}

/** The first characters of a page's notes (the page list preview). */
export function snippetOf(page, max = 120) {
  const doc = nodeOf(page.body);
  let out = '';
  doc.descendants(node => {
    if (out.length >= max) return false;
    if (node.isTextblock) { const t = node.textContent.trim(); if (t) out += (out ? ' ' : '') + t; return false; }
    return true;
  });
  return out.length > max ? out.slice(0, max - 1) + '…' : out;
}
