// Export a PDF > Image: the pages drawn at a resolution and written as PNG, JPEG or TIFF files, one per page, into a folder the person chooses.
//
// Translated from printcraft crates/ui-egui/src/workflows/export_ui.rs (the dialog: Resolution 72, 96, 150, 300 or 600 pixels/inch, Format PNG, JPEG
// with Quality 10 to 100, TIFF; Pages; "One <format> file per page, named after the document"; the files "<document>_page_<n>.<ext>"; "Exported n
// images", with " (n at <dpi> dpi, the largest size they can be drawn at)" for pages too large for the resolution) and crates/export (ImageFormat) at
// 8f16855 (MIT, see assets/third-party-licenses/artcraft-reference.txt). The pages are drawn by pdf.js, which draws the page's own content and
// the file's annotations; the comments this window paints itself (its own comment painter) are not in the pictures. The document must allow copying.

import {defineCommands} from '../../../../core/kernel/command.mjs';
import {s} from '../../../../core/kernel/schema.mjs';
import {CommandError} from '../../../../core/kernel/errors.mjs';
import {copying, guard} from '../../../../core/folio/lib/edit-needs.mjs';
import {viewSize, pageRotation} from '../../../../core/folio/lib/geom.mjs';
import {encodeTiff} from '../../../../core/folio/lib/image-files.mjs';
import {stem} from '../../../../core/folio/lib/page-files.mjs';
import {writeSet, folderState} from '../../../../core/folio/lib/folder-out.mjs';
import {acquire, release, raster} from '../surface/pdf';

const UPSTREAM = {repo: 'printcraft' as const, commit: '8f16855', files: ['crates/ui-egui/src/workflows/export_ui.rs']};
/** The most pixels a page is drawn with; a larger page is drawn at the most it allows and the result says so. */
const MAX_PIXELS = 40_000_000;
const EXT: Record<string, string> = {png: 'png', jpeg: 'jpg', tiff: 'tif'};

const both = (a: any, b: any) => (ctx: any) => { const x = a(ctx); return x.enabled ? b(ctx) : x; };
const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the page could not be encoded'))), type, quality));

export default defineCommands({
  family: 'export_image',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'export.image', label: 'Export to image…', risk: 'read', undo: 'none', needs: 'view', dialog: 'dialog.export-image',
      description: 'Export pages as pictures, one file per page named "<document>_page_<n>.<ext>": `dpi` 18 to 1200 (default 150), `format` png, jpeg (`quality` 10 to 100, default 85) or tiff, `pages` 0-based (default all). A page too large for the resolution is drawn at the most it allows (`lowered` says which). From the window the files go into a folder chosen in the system folder dialog; a program gets them as base64 and nothing is written. The document must allow copying its content.',
      params: s.object({
        dpi: s.optional(s.number({min: 18, max: 1200})), format: s.optional(s.enum(['png', 'jpeg', 'tiff'])), quality: s.optional(s.integer({min: 10, max: 100})),
        pages: s.optional(s.array(s.integer({min: 0, max: 99999}), {min: 1, max: 10000})),
      }),
      state: both(copying, folderState),
      async run(ctx: any, p: any) {
        guard(ctx, copying);
        const dpi = p.dpi ?? 150, format: string = p.format ?? 'png', quality = (p.quality ?? 85) / 100;
        const list: number[] = p.pages ?? ctx.doc.pages.map((_: unknown, i: number) => i);
        const bad = list.find(i => i >= ctx.doc.pages.length);
        if (bad !== undefined) throw new CommandError('not_found', `page ${bad + 1} does not exist`, {path: '/pages'});
        const base = stem(ctx.doc.sourceName || ctx.file?.title || 'Document');
        const source = acquire(ctx.doc.sourceBase64);
        const files: {name: string; bytes: Uint8Array}[] = [], lowered: number[] = [];
        try {
          for (const i of list) {
            const page = ctx.doc.pages[i];
            const {width, height} = viewSize(page);
            let scale = dpi / 72;
            const cap = Math.sqrt(MAX_PIXELS / Math.max(1, width * height));
            if (scale > cap) { scale = cap; lowered.push(Math.floor(scale * 72)); }
            const canvas = await raster(source, page.sourceIndex, pageRotation(page), scale, new Set(), new AbortController().signal);
            let bytes: Uint8Array;
            if (format === 'tiff') {
              const shot = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
              const rgb = new Uint8Array(shot.width * shot.height * 3);
              for (let k = 0; k < shot.width * shot.height; k++) { rgb[k * 3] = shot.data[k * 4]; rgb[k * 3 + 1] = shot.data[k * 4 + 1]; rgb[k * 3 + 2] = shot.data[k * 4 + 2]; }
              bytes = encodeTiff({width: shot.width, height: shot.height, rgb, dpi: Math.round(scale * 72)});
            } else bytes = new Uint8Array(await (await toBlob(canvas, format === 'jpeg' ? 'image/jpeg' : 'image/png', format === 'jpeg' ? quality : undefined)).arrayBuffer());
            files.push({name: `${base}_page_${i + 1}.${EXT[format]}`, bytes});
          }
        } finally { release(source); }
        const out = await writeSet(ctx, files, {title: 'Choose a folder for the exported images'});
        if (out.canceled) return {exported: 0, canceled: true};
        const n = files.length;
        let message = n === 1 ? 'Exported 1 image' : `Exported ${n} images`;
        if (out.folder) message += ` to ${out.folder}`;
        if (lowered.length) message += ` (${lowered.length} at ${Math.min(...lowered)} dpi, the largest size they can be drawn at)`;
        return {exported: n, format, dpi, names: out.written, lowered, ...(out.files ? {files: out.files} : {folder: out.folder}), message};
      },
    },
  ],
});
