// Export a PDF > Export all images: the pictures the pages use, as files in a folder the person chooses. (Export to Image, which draws the pages,
// needs the page renderer: src/apps/folio/ui-commands/export-image.ts.)
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/commands.rs:524        export.all_images opens the export dialog (Needs::Copying)
//   crates/ui-egui/src/workflows/export_ui.rs  the dialog (Exclude images smaller than: no limit, 16, 32, 64, 128, 256 pixels; Pages: all, current,
//                                              range; "Each image once, named after the document and page. JPEG images are saved unchanged; others as
//                                              PNG."), the folder chooser, "Exported n images to <folder>" with " (n not exported: <first reason>)"
//   crates/create/src/extract.rs               the images themselves (core/folio/lib/image-files.mjs)
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/export-images.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {copying, guard} from '../lib/edit-needs.mjs';
import {loadSource} from '../lib/page-source.mjs';
import {stem} from '../lib/page-files.mjs';
import {extractImages} from '../lib/image-files.mjs';
import {writeSet, folderState} from '../lib/folder-out.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/workflows/export_ui.rs', 'crates/create/src/extract.rs']};
const both = (a, b) => ctx => { const x = a(ctx); return x.enabled ? b(ctx) : x; };

export default defineCommands({
  family: 'export_images',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'export.all_images', label: 'Export all images…', risk: 'read', undo: 'none', needs: 'worker', dialog: 'dialog.export-all-images',
      description: 'Export the pictures the pages use as files: each once (on the first page that uses it), JPEG pictures unchanged, others as PNG with their soft mask as alpha, named "<document>_image_<n>.<ext>"; `minSide` leaves out pictures shorter than that many pixels; pictures it cannot decode (JBIG2, CCITT, JPEG 2000, CMYK or transparent JPEG) are named in `skipped`. From the window the files go into a folder chosen in the system folder dialog; a program gets them as base64 and nothing is written. The document must allow copying its content.',
      params: s.object({
        pages: s.optional(s.array(s.integer({min: 0, max: 99999}), {min: 1, max: 10000, description: '0-based pages (default: all)'})),
        minSide: s.optional(s.integer({min: 0, max: 100000, description: 'Leave out pictures with fewer pixels than this on their shorter side'})),
      }),
      state: both(copying, folderState),
      async run(ctx, p) {
        guard(ctx, copying);
        const count = ctx.doc.pages.length;
        const list = p.pages ?? ctx.doc.pages.map((_, i) => i);
        const bad = list.find(i => i >= count);
        if (bad !== undefined) throw new CommandError('not_found', `page ${bad + 1} does not exist`, {path: '/pages'});
        const doc = await loadSource(ctx.doc);
        // The model's page i is the source page its record names.
        const sourcePages = list.map(i => ctx.doc.pages[i].sourceIndex);
        const r = await extractImages(doc, sourcePages, p.minSide ?? 0);
        if (!r.images.length) {
          return {exported: 0, skipped: r.skipped, message: r.skipped.length ? `No image could be exported (${r.skipped[0].why})` : 'There are no images to export'};
        }
        const base = stem(ctx.doc.sourceName || ctx.file?.title || 'Document');
        const files = r.images.map(im => ({name: `${base}_image_${im.index}.${im.ext}`, bytes: im.bytes}));
        const out = await writeSet(ctx, files, {title: 'Choose a folder for the exported images'});
        if (out.canceled) return {exported: 0, canceled: true};
        const n = files.length;
        let message = n === 1 ? 'Exported 1 image' : `Exported ${n} images`;
        if (out.folder) message += ` to ${out.folder}`;
        if (r.skipped.length) message += ` (${r.skipped.length} not exported: ${r.skipped[0].why})`;
        return {exported: n, names: out.written, skipped: r.skipped, ...(out.files ? {files: out.files} : {folder: out.folder}), message};
      },
    },
  ],
});
