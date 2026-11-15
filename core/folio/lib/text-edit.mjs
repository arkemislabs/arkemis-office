// The text editor's page API: a page's editable paragraphs, listed for the surface and rewritten on request.
//
// Translated from printcraft at 8f16855 (MIT, see assets/third-party-licenses/artcraft-reference.txt): crates/edit/src/text/blocks.rs text_blocks,
// BlockKey, block_overlapping and rewrite.rs rewrite_block / replace_block (text-blocks.mjs, text-rewrite.mjs hold the translation).
// No DOM, no Node built-ins.

import {readPage, readPageAsync} from './text-interp.mjs';
import {isAddedStream} from './added.mjs';
import {groupBlocks, blockKey, findBlock, blockOverlapping} from './text-blocks.mjs';
import {rewriteFrom} from './text-rewrite.mjs';

/** text_blocks: the page's paragraphs with the lines they come from (vertical text is left out). */
export function pageBlocks(doc, page) {
  const read = readPage(doc, page);
  const lines = read.lines.filter(l => !l.vertical && !isAddedStream(doc, read.streams[l.stream]?.ref));
  return {read, lines, blocks: groupBlocks(lines)};
}

/** pageBlocks in slices: a large page is read without freezing the window (the commands use this one). */
export async function pageBlocksAsync(doc, page) {
  const read = await readPageAsync(doc, page);
  const lines = read.lines.filter(l => !l.vertical && !isAddedStream(doc, read.streams[l.stream]?.ref));
  return {read, lines, blocks: groupBlocks(lines)};
}

const rgbHex = c => `#${c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;

/** A block as the surface and the bridge read it (user-space box; the command turns it into view space). */
export function describeBlock(block, lines, index) {
  const refusal = block.lines.map(i => lines[i].refusal).find(Boolean) ?? null;
  const first = lines[block.lines[0]];
  return {
    index, key: blockKey(block), text: block.editorText, reflowText: block.reflowText, rect: block.rect, rows: block.rows.length, size: block.size,
    bold: block.bold, italic: block.italic, color: rgbHex(block.color), font: block.baseFont, rotation: block.rotation, invisible: block.invisible,
    leading: block.rows.length > 1 ? undefined : undefined, scale: first.origin.state.scale * 100, charSpacing: first.origin.state.charSpacing * first.origin.k,
    editable: refusal === null, refusal,
  };
}

/** rewrite_block: replace paragraph `key` (its text and box, as listed) with `text` and the style. */
export function rewriteByKey(doc, page, key, hint, text, style = {}) {
  const listing = pageBlocks(doc, page);
  const at = findBlock(listing.blocks, key, hint);
  if (at === null) return null;
  return {at, result: rewriteFrom(doc, page, listing.read, listing.lines, listing.blocks, listing.blocks[at], text, style)};
}

export {blockOverlapping, findBlock};
