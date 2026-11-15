// File > Open / Save for documents the new shell edits (docs/architecture.md section 18), run in the
// format worker (electron/format-worker.cjs). Electron-agnostic: the bridge contract tests call it
// directly.
//
// Writing:
//  * a schema-2 document goes through its app's format module, indexed in
//    core/generated/<app>.formats.mjs: core/<app>/formats/<ext>-write.mjs exports
//    write(file, {resolvedLinks}) -> Uint8Array | Buffer | string;
//  * a PDF whose content is the folio model (content.folio === 2: comments in pages[].annots, crop
//    boxes, fields) is written by core/folio/formats/pdf-write.mjs when it exists, else by
//    core/folio/model/pdf-write.mjs `writeFolioPdf` (every comment a real annotation with its
//    appearance, untouched file comments written back as the same objects);
//  * everything else (schema 1) keeps electron/formats.cjs.
// Reading: core/<app>/formats/<ext>-read.mjs exports read(bytes: Uint8Array, {title, kind}) ->
// schema-2 content. Where an app has no reader for the extension yet, the schema-1 converter
// (electron/formats.cjs) reads it and, when the new shell edits that app, the app's migrate.mjs
// converts the result at once, so the working copy is schema 2 from the start.

const {exportDocument, importDocument} = require('./formats.cjs');

const formatIndexes = {
  quill: () => import('../core/generated/quill.formats.mjs'),
  grid: () => import('../core/generated/grid.formats.mjs'),
  prism: () => import('../core/generated/prism.formats.mjs'),
  folio: () => import('../core/generated/folio.formats.mjs'),
  slate: () => import('../core/generated/slate.formats.mjs'),
};

/** core/generated/<kind>.formats.mjs `formats` ({ext: {read?, write?}}), or {} when the app has none. */
async function appFormats(kind) {
  const load = formatIndexes[kind];
  if (!load) return {};
  try { return (await load()).formats ?? {}; } catch { return {}; }
}
async function foundations() {
  try { return (await import('../core/generated/apps.mjs')).apps ?? {}; } catch { return {}; }
}
const isFolio2 = file => file?.kind === 'folio' && file.content?.folio === 2;

/** Bytes of `file` in `format` (Uint8Array, Buffer or string). */
async function exportFile(file, format, {formats = appFormats} = {}) {
  if (file?.schema === 2 || isFolio2(file)) {
    const writer = (await formats(file.kind))[format]?.write;
    if (typeof writer?.write === 'function') return writer.write(file, {resolvedLinks: file.resolvedLinks ?? []});
    if (isFolio2(file) && format === 'pdf') {
      const {writeFolioPdf} = await import('../core/folio/model/pdf-write.mjs');
      return writeFolioPdf(file.content, {encrypt: true});
    }
    if (file.schema === 2) {
      const ext = String(format).toUpperCase();
      throw new Error(`Saving as ${ext} is not available for this document yet: its ${ext} writer has not been translated.`);
    }
  }
  return exportDocument(file, format);
}

/**
 * A new document read from `data` (a file's bytes) with extension `format`.
 * @param {{title: string, kind?: string|null, newHost?: boolean, formats?: Function, apps?: () => Promise<object>}} opts
 *   kind: the app opening it (a single-app product), else every app that reads the extension is tried.
 *   newHost: the new shell edits these documents; an app whose manifest is ready always counts.
 */
async function importFile(data, format, {title, kind = null, newHost = false, formats = appFormats, apps = foundations} = {}) {
  const all = await apps();
  const v2 = k => typeof all[k]?.schema?.createContent === 'function' && (all[k].ready === true || newHost === true);
  const model = await import('../core/model.mjs');
  const candidates = kind ? [kind] : Object.keys(all);
  for (const k of candidates) {
    if (!v2(k)) continue;
    const reader = (await formats(k))[format]?.read;
    if (typeof reader?.read !== 'function') continue;
    const file = model.createFile(k, title, {schema: 2});
    file.content = await reader.read(new Uint8Array(data), {title, kind: k});
    return model.validateFile(file);
  }
  const file = await importDocument(data, format, title);
  if (!v2(file.kind)) return file;
  // No schema-2 reader for this extension yet: the schema-1 converter's result, converted now.
  const {migrateOnOpen} = await import('../core/kernel/open-migrate.mjs');
  const r = await migrateOnOpen(all[file.kind], file);
  return r.migrated ? model.validateFile(r.file) : file;
}

module.exports = {exportFile, importFile, appFormats};
