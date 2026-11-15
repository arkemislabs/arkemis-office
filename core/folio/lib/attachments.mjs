// Document-level file attachments (Acrobat: Edit > Attach file; the Attachments panel): the /Names /EmbeddedFiles name tree of file specifications, each with
// its embedded stream. (A FileAttachment annotation, a paper clip on a page, is a comment and lives in the comment commands.)
//
// Translated from printcraft at 8f16855 (Release 0.16.0, MIT, see assets/third-party-licenses/artcraft-reference.txt): crates/organize/src/attachments.rs
// (attachment_keys, add_attachment: the key is the file name without any folder, made unique with " (2)", " (3)"; the embedded stream carries /Size and
// /ModDate and the type as /Subtype; the file specification /F, /UF, /Desc and /EF; the tree is rewritten sorted), delete_attachment, entries;
// crates/ui-egui/src/app/files.rs attach_file (mime_for_name). The name tree is written flat (one /Names array); an existing tree with /Kids is read through.
// No DOM, no Node built-ins.

import {PDFName, PDFDict, PDFArray, PDFHexString, PDFString, PDFRef} from 'pdf-lib';
import {CommandError} from '../../kernel/errors.mjs';

const N = s => PDFName.of(s);
const MAX_DEPTH = 16;
const MIME = {pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', txt: 'text/plain', csv: 'text/csv', json: 'application/json',
  xml: 'application/xml', html: 'text/html', htm: 'text/html', zip: 'application/zip', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'};

/** mime_for_name: the media type a file name stands for, when it is a known one. */
export const mimeForName = name => MIME[String(name).split('.').pop().toLowerCase()] ?? null;
/** file_name: a file name without any folder part. */
export const fileName = name => String(name ?? '').split(/[\\/]/).pop().trim();

const textOf = v => (v instanceof PDFHexString || v instanceof PDFString ? v.decodeText() : '');

/** The /EmbeddedFiles entries [key text, key object, file specification], in tree order (a tree with /Kids is read through). */
export function attachmentEntries(doc) {
  const ctx = doc.context;
  const names = ctx.lookup(doc.catalog.get(N('Names')));
  const root = names instanceof PDFDict ? ctx.lookup(names.get(N('EmbeddedFiles'))) : null;
  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!(node instanceof PDFDict) || depth > MAX_DEPTH || seen.has(node)) return;
    seen.add(node);
    const list = ctx.lookup(node.get(N('Names')));
    if (list instanceof PDFArray) {
      const items = list.asArray();
      for (let i = 0; i + 1 < items.length; i += 2) {
        const key = ctx.lookup(items[i]);
        out.push([textOf(key), key, items[i + 1]]);
      }
    }
    const kids = ctx.lookup(node.get(N('Kids')));
    if (kids instanceof PDFArray) for (const k of kids.asArray()) walk(ctx.lookup(k), depth + 1);
  };
  walk(root, 0);
  return out;
}

/** attachment_keys. */
export const attachmentKeys = doc => attachmentEntries(doc).map(e => e[0]);

/** The attachments with what the panel shows: name, size, type, description. */
export function listAttachments(doc) {
  const ctx = doc.context;
  return attachmentEntries(doc).map(([key, , spec]) => {
    const d = ctx.lookup(spec);
    const ef = d instanceof PDFDict ? ctx.lookup(d.get(N('EF'))) : null;
    const stream = ef instanceof PDFDict ? ctx.lookup(ef.get(N('UF')) ?? ef.get(N('F'))) : null;
    const params = stream?.dict ? ctx.lookup(stream.dict.get(N('Params'))) : null;
    const size = params instanceof PDFDict ? ctx.lookup(params.get(N('Size'))) : null;
    const sub = stream?.dict?.get(N('Subtype'));
    return {name: key, size: size && typeof size.asNumber === 'function' ? size.asNumber() : null, type: sub instanceof PDFName ? sub.decodeText() : null,
      description: d instanceof PDFDict ? textOf(ctx.lookup(d.get(N('Desc')))) : ''};
  });
}

/**
 * add_attachment: attach `bytes` to the document under `name`; the name tree's key is the name made unique with " (2)", " (3)"... and is returned.
 * `date` is a PDF date string for /ModDate, `mime` the embedded file's /Subtype when known.
 */
export function addAttachment(doc, {name, bytes, description = null, mime = null, date = null}) {
  const ctx = doc.context;
  const base = fileName(name);
  if (!base) throw new CommandError('invalid_params', 'the attachment needs a file name');
  const all = attachmentEntries(doc);
  const taken = new Set(all.map(e => e[0]));
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base} (${n})`;
  const params = {Size: bytes.length};
  if (date) params.ModDate = PDFString.of(date);
  const ef = {Type: 'EmbeddedFile', Params: ctx.obj(params)};
  if (mime && String(mime).trim()) ef.Subtype = N(String(mime).trim());
  const stream = ctx.register(ctx.flateStream(bytes, ef));
  const spec = {Type: 'Filespec', F: PDFHexString.fromText(key), UF: PDFHexString.fromText(key), EF: ctx.obj({F: stream, UF: stream})};
  if (description && String(description).trim()) spec.Desc = PDFHexString.fromText(String(description).trim());
  const specRef = ctx.register(ctx.obj(spec));
  const entries = [...all.map(([k, keyObj, v]) => [k, keyObj, v]), [key, PDFHexString.fromText(key), specRef]];
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const flat = entries.flatMap(([, keyObj, v]) => [keyObj, v]);
  const tree = ctx.obj({Names: flat});
  let names = ctx.lookup(doc.catalog.get(N('Names')));
  if (!(names instanceof PDFDict)) { names = ctx.obj({}); doc.catalog.set(N('Names'), names); }
  names.set(N('EmbeddedFiles'), tree);
  return key;
}

export {PDFRef};
