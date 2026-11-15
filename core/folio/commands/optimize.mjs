// Compress a PDF: Reduce file size and the PDF Optimizer (Advanced optimization). Each writes an optimized COPY of the document, "<name> (reduced).pdf"
// or "<name> (optimized).pdf", through the system Save dialog; the open document is not changed.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/commands.rs:239,245     optimize.reduce (Reduce File Size with Settings::default) and optimize.advanced (the dialog)
//   crates/ui-egui/src/workflows/create_ui.rs  reduce_file_size, save_optimized: the copy named "<name> (reduced).pdf" / "(optimized).pdf"; a Reduce File Size
//                                              copy that is not smaller is not saved ("This file is already as small as it can be made (<size>). No copy
//                                              was saved."); the report "<before> -> <after> (<n>% smaller)"
//   crates/optimize/src/lib.rs                 the settings (core/folio/lib/optimize.mjs says which are translated)
// The picture settings (down-sampling and re-compressing pictures) are not translated, so the dialog offers the structural ones.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/optimize.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {documentOpen} from '../lib/edit-needs.mjs';
import {writeOther, writeState, stem} from '../lib/page-files.mjs';
import {writeFolioPdf} from '../model/pdf-write.mjs';
import {optimizePdf, DEFAULTS} from '../lib/optimize.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/workflows/create_ui.rs', 'crates/optimize/src/lib.rs']};
const both = (a, b) => ctx => { const x = a(ctx); return x.enabled ? b(ctx) : x; };
const size = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} KB` : `${n} B`);
const bool = s.optional(s.boolean());

async function make(ctx, p, settings, suffix, {onlyIfSmaller}) {
  const current = await writeFolioPdf(ctx.doc);
  const r = await optimizePdf(current, settings);
  if (onlyIfSmaller && r.after >= r.before) return {saved: false, before: r.before, after: r.after, report: r.report, message: `This file is already as small as it can be made (${size(r.before)}). No copy was saved.`};
  const name = `${stem(ctx.doc.sourceName || ctx.file?.title || 'Document')} (${suffix}).pdf`;
  const out = await writeOther(ctx, {path: p.path}, r.bytes, {title: 'Save the optimized copy', name});
  if (out.canceled) return {canceled: true};
  const pct = 100 * (1 - r.after / Math.max(1, r.before));
  const message = r.after < r.before ? `Saved ${out.path ?? name}: ${size(r.before)} → ${size(r.after)} (${pct.toFixed(0)}% smaller)` : `Saved ${out.path ?? name}: ${size(r.before)} → ${size(r.after)}`;
  return {saved: true, ...out, name, before: r.before, after: r.after, report: r.report, message};
}

export default defineCommands({
  family: 'optimize',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'optimize.reduce', label: 'Reduce file size', risk: 'read', undo: 'none', needs: 'worker',
      description: 'Save a smaller copy of the document as "<name> (reduced).pdf": discards thumbnails and alternate images, stores LZW and unfiltered streams with Flate, packs the objects into object streams and leaves out what edits left unused. Nothing is saved when the copy is not smaller. `path` is where to write it (default: the Save dialog; a program gets the bytes as base64). Pictures are not re-compressed.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096}))}),
      state: both(documentOpen, writeState),
      run: (ctx, p) => make(ctx, p, DEFAULTS, 'reduced', {onlyIfSmaller: true}),
    },
    {
      id: 'optimize.advanced', label: 'Advanced optimization…', risk: 'read', undo: 'none', needs: 'worker', dialog: 'dialog.optimize',
      description: 'The PDF Optimizer: save an optimized copy as "<name> (optimized).pdf" with the chosen settings (all on by default except discardTags and discardPrintSettings): discardThumbnails, discardAlternates, discardTags (the structure tree), discardPrintSettings (the print keys of the viewer preferences), lzwToFlate, flateUnencoded, objectStreams, discardUnused. The copy is saved even when it is not smaller.',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096})), discardThumbnails: bool, discardAlternates: bool, discardTags: bool, discardPrintSettings: bool, lzwToFlate: bool, flateUnencoded: bool, objectStreams: bool, discardUnused: bool}),
      state: both(documentOpen, writeState),
      run(ctx, p) {
        const {path, ...given} = p;
        return make(ctx, {path}, {...DEFAULTS, ...given}, 'optimized', {onlyIfSmaller: false});
      },
    },
  ],
});
