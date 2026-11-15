// The text editor's heavy work as plain operations on bytes: read a page's paragraphs, rewrite one, move one. They run in a worker of their own
// (src/workers/folio-text.ts, started by text-client.mjs) so a large page never stalls the window, and in the calling thread, in slices, when no worker
// can be started (headless hosts, tests). An operation takes the PDF as `base64` (the document's source) or `bytes`, and returns plain data, plus the new
// bytes when it changed the file. Nothing in the document is executed. No DOM, no Node built-ins.

import '../../common/lib/pdf-guard.mjs';
import {PDFDocument, PDFName, PDFDict} from 'pdf-lib';
import {bytesOf} from './page-source.mjs';
import {pageBlocksAsync, describeBlock} from './text-edit.mjs';
import {findBlock, blockOverlapping} from './text-blocks.mjs';
import {rewriteFrom, translateBlocks} from './text-rewrite.mjs';
import {TextError} from './text-interp.mjs';
import {Metrics} from './text-font.mjs';

const load = args => PDFDocument.load(args.bytes ?? bytesOf(args.base64), {updateMetadata: false, ignoreEncryption: true});
const notFound = (message, path) => Object.assign(new TextError(message, 'not_found'), {path});

/** The face names the page's fonts show, by resource (the Font control's list and the `resource` style). */
function pageFonts(doc, src) {
  const res = src.node.Resources();
  const fonts = res?.lookup(PDFName.of('Font'));
  const out = [];
  if (!(fonts instanceof PDFDict)) return out;
  for (const key of fonts.keys()) {
    const name = key.decodeText();
    if (name.startsWith('PCEd')) continue;
    const d = fonts.lookup(key);
    if (!(d instanceof PDFDict)) continue;
    try { out.push({resource: name, face: Metrics.fromDict(doc.context, d).baseFont || name}); } catch { /* an unreadable font is not offered */ }
  }
  return out;
}

/** The paragraph a call names: by key (what it says and where), else by index. */
function pick(blocks, key, index) {
  const at = key ? findBlock(blocks, key, index ?? 0) : index;
  if (at === null || at === undefined || !blocks[at]) throw notFound(key ? 'that paragraph is no longer on the page' : 'the page has no such paragraph', key ? '/key' : '/index');
  return at;
}

export const OPS = {
  /** Every paragraph of page `sourceIndex` as the surface reads it (user-space boxes), and the page's fonts. */
  async blocks(args) {
    const doc = await load(args);
    const src = doc.getPage(args.sourceIndex);
    const listing = await pageBlocksAsync(doc, src);
    return {blocks: listing.blocks.map((b, i) => describeBlock(b, listing.lines, i)), fonts: pageFonts(doc, src)};
  },

  /** Rewrite one paragraph: the new file's bytes, what the rewrite did, and the paragraph it became. */
  async replace(args) {
    const doc = await load(args);
    const src = doc.getPage(args.sourceIndex);
    const entry = await pageBlocksAsync(doc, src);
    const at = pick(entry.blocks, args.key, args.index);
    const result = rewriteFrom(doc, src, entry.read, entry.lines, entry.blocks, entry.blocks[at], args.text, args.style ?? {});
    const bytes = await doc.save({updateFieldAppearances: false});
    let after = null;
    try {
      const next = await pageBlocksAsync(doc, src);
      const n = blockOverlapping(next.blocks, entry.blocks[at].rect);
      if (n !== null) after = describeBlock(next.blocks[n], next.lines, n);
    } catch { /* the edit stands; the listing is read again on the next click */ }
    return {bytes, result, at, after};
  },

  /** Move one paragraph by [dx, dy] in the page's user space without touching its glyphs. */
  async move(args) {
    const doc = await load(args);
    const src = doc.getPage(args.sourceIndex);
    const entry = await pageBlocksAsync(doc, src);
    const at = pick(entry.blocks, args.key, args.index);
    translateBlocks(doc, src, entry.read, entry.lines, entry.blocks, [at], args.offset);
    const bytes = await doc.save({updateFieldAppearances: false});
    let after = null;
    try {
      const next = await pageBlocksAsync(doc, src);
      const m = entry.blocks[at].rect;
      const n = blockOverlapping(next.blocks, [m[0] + args.offset[0], m[1] + args.offset[1], m[2] + args.offset[0], m[3] + args.offset[1]]);
      if (n !== null) after = describeBlock(next.blocks[n], next.lines, n);
    } catch { /* the move stands */ }
    return {bytes, at, after};
  },
};
