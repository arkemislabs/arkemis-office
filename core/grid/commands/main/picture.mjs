// Home > Clipboard: Copy as Picture and Paste > Picture. The cells are drawn to a PNG by the window (the host's `renderRange`, the
// worksheet's own painter, as shown on screen) and travel on the clipboard as a picture, with the cells' text and an <img> for other
// applications; Paste > Picture puts the copied picture, or a picture of the cells that were copied, on the sheet as a floating picture.
// Not in gridcraft (it copies cell data and an HTML table; not checked against upstream): Office's behaviour. Paste > Linked Picture
// is a picture object carrying `link: {sheet, range}`: the worksheet draws it live from those cells, so it follows them as they change (its stored image is only the snapshot a file keeps: an .xlsx written from here holds that still picture).

import {defineCommands} from '../../../kernel/command.mjs';
import {s} from '../../../kernel/schema.mjs';
import {CommandError} from '../../../kernel/errors.mjs';
import {writeClipboard} from '../../../common/lib/clipboard.mjs';
import {a1, rangeA1, parseRange, isFullCols, isFullRows, intersection, union, rangeCell} from '../../lib/addr.mjs';
import {usedBounds} from '../../model/store.mjs';
import {rangeText} from '../../lib/edit-clip.mjs';
import {setIn} from '../../lib/edit-parts.mjs';
import {hasDoc, gridSel, targetRanges, failed, requireSchema2, baseDoc} from '../../lib/edit-targets.mjs';
import {nextObjectId, objectSelection, topZ} from '../../lib/objects.mjs';
import {gridClip} from '../edit/clipboard.mjs';

const UPSTREAM = {repo: 'gridcraft', commit: '146161b4b450a56e5e59a083ba0478582d1e602b', files: []};
const MULTIPLE = "This action won't work on multiple selections.";
const PROTECTED = 'The cell or chart you are trying to change is on a protected sheet. To make a change, unprotect the sheet.';
export const PICTURE_KIND = 'grid.picture';

const needDraw = ctx => {
  if (typeof ctx.host?.renderRange !== 'function') throw new CommandError('unavailable', 'A picture of cells can only be drawn with the workbook open in a window', {hint: 'documents.open'});
  return ctx.host.renderRange;
};

/** Whole rows or columns picture the cells that hold data (as Copy does); anything else as it is. */
function trimmed(sheet, r) {
  if (!isFullCols(r) && !isFullRows(r)) return r;
  const b = usedBounds(sheet);
  const used = b ? {start: {row: b.r0, col: b.c0}, end: {row: b.r1, col: b.c1}} : rangeCell(r.start);
  return intersection(r, union(used, rangeCell(r.start))) ?? r;
}

async function copyPicture(ctx, p) {
  const {sheet: si, areas} = targetRanges(ctx, p);
  requireSchema2(ctx, si);
  if (areas.length > 1) throw failed(MULTIPLE);
  const content = ctx.doc;
  const sheet = content.sheets[si];
  const range = trimmed(sheet, areas[0]);
  const img = await needDraw(ctx)(content, si, range, p.scale ?? 2);
  const base64 = String(img.dataUrl).replace(/^data:[^,]*,/, '');
  const text = rangeText(content, si, range);
  await writeClipboard(ctx, {
    text, html: `<img src="${img.dataUrl}" width="${img.width}" height="${img.height}" alt="">`, kind: PICTURE_KIND,
    data: {mime: 'image/png', base64, width: img.width, height: img.height, range: rangeA1(range), sheet: sheet.name},
    label: `Picture of ${sheet.name}!${rangeA1(range)}`,
  });
  return {range: rangeA1(range), width: img.width, height: img.height};
}

/** The picture Paste > Picture puts down: the copied picture, else a picture of the cells that were copied. */
async function clipboardPicture(ctx) {
  const c = ctx.clipboard;
  if (c && c.app === 'grid' && c.kind === PICTURE_KIND && c.data?.base64) return c.data;
  const clip = gridClip(ctx);
  if (!clip) return null;
  const source = clip.source ?? ctx.doc;
  const si = source.sheets.findIndex(sh => sh.id === clip.sheetId);
  const range = parseRange(clip.range);
  if (si < 0 || !range) return null;
  const img = await needDraw(ctx)(source, si, range, 2);
  return {mime: 'image/png', base64: String(img.dataUrl).replace(/^data:[^,]*,/, ''), width: img.width, height: img.height, range: clip.range, sheet: clip.sheetName};
}

export async function pastePicture(ctx, p) {
  baseDoc(ctx);
  const pic = await clipboardPicture(ctx);
  if (!pic) throw failed('Nothing to paste.');
  const si = gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  const content = ctx.doc;
  const sheet = content.sheets[si];
  if (sheet.protection?.enabled && !sheet.protection.objects) throw failed(PROTECTED);
  const at = gridSel(ctx).active;
  const id = nextObjectId(content);
  const image = {id, ...topZ(sheet), anchor: {cell: a1(at.row, at.col), dx: 0, dy: 0, width: pic.width, height: pic.height, mode: 'moveOnly'},
    data: pic.base64, mime: pic.mime, alt: `Picture of ${pic.sheet}!${pic.range}`};
  setIn(ctx.change, ['sheets', si, 'images'], [...(sheet.images ?? []), image]);
  ctx.setSelection(objectSelection(sheet, 'image', id));
  return {image: id};
}

/** Paste > Linked Picture: a picture of the copied cells that the worksheet draws live from them (`link: {sheet, range}`). */
async function pasteLinkedPicture(ctx) {
  baseDoc(ctx);
  const clip = gridClip(ctx);
  if (!clip) throw failed('Copy cells first: a linked picture follows the cells that were copied.');
  const from = ctx.doc.sheets.find(sh => sh.id === clip.sheetId);
  if (!from) throw failed('The copied cells are in another workbook.');
  const pic = await clipboardPicture(ctx);
  const si = gridSel(ctx).sheet;
  requireSchema2(ctx, si);
  const content = ctx.doc;
  const sheet = content.sheets[si];
  if (sheet.protection?.enabled && !sheet.protection.objects) throw failed(PROTECTED);
  const at = gridSel(ctx).active;
  const id = nextObjectId(content);
  const image = {id, ...topZ(sheet), anchor: {cell: a1(at.row, at.col), dx: 0, dy: 0, width: pic.width, height: pic.height, mode: 'moveOnly'},
    data: pic.base64, mime: pic.mime, alt: `Linked picture of ${from.name}!${clip.range}`, link: {sheet: from.id, range: clip.range}};
  setIn(ctx.change, ['sheets', si, 'images'], [...(sheet.images ?? []), image]);
  ctx.setSelection(objectSelection(sheet, 'image', id));
  return {image: id, link: image.link};
}

const hasLinkable = ctx => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  return gridClip(ctx) ? {enabled: true} : {enabled: false, reason: 'copy cells first'};
};

const hasPicture = ctx => {
  const st = hasDoc(ctx);
  if (!st.enabled) return st;
  return ctx.clipboard && (ctx.clipboard.kind === PICTURE_KIND || gridClip(ctx)) ? {enabled: true} : {enabled: false, reason: 'the clipboard is empty'};
};

export default defineCommands({
  family: 'main/picture',
  app: 'grid',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'edit.copyPicture', label: 'Copy as Picture', risk: 'read', effect: 'view', undo: 'none', repeatable: false,
      description: 'Copy the selection (or range) as a picture, as shown on screen: a PNG on the clipboard that Paste > Picture puts on the sheet.',
      params: s.object({range: s.optional(s.string({min: 1, max: 4096})), sheet: s.optional(s.union([s.string({min: 1, max: 300}), s.integer({min: 0, max: 254})])), scale: s.optional(s.number({min: 0.5, max: 4}))}),
      state: hasDoc,
      run: copyPicture,
    },
    {
      id: 'edit.pastePicture', label: 'Picture', risk: 'edit',
      description: 'Paste what was copied as a floating picture at the active cell: a picture copied with Copy as Picture, else a picture of the copied cells.',
      params: s.object({}),
      state: hasPicture,
      run: pastePicture,
    },
    {
      id: 'edit.pasteLinkedPicture', label: 'Linked Picture', risk: 'edit',
      description: 'Paste the copied cells as a floating picture that follows them: it is drawn live from those cells and changes when they do.',
      params: s.object({}),
      state: hasLinkable,
      run: pasteLinkedPicture,
    },
  ],
});
