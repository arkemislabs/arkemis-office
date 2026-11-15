// Export a PDF > PostScript and Encapsulated PostScript: the pages drawn at a resolution and written as a PostScript Level 2 file (one page each) or an EPS file (one page).
//
// Not checked against upstream (printcraft at 8f16855 plans PostScript / EPS, catalog.rs M10, and has no engine for it). Each page is drawn by pdf.js, as Export to Image draws
// it, and written as a JPEG picture the size of the page (DCTDecode, ASCII85): the text is not kept as text and the fonts are not embedded, which the result says. The
// document must allow copying its content. See lib/export-more.mjs `postscript`.

import {defineCommands} from '../../../../core/kernel/command.mjs';
import {s} from '../../../../core/kernel/schema.mjs';
import {CommandError} from '../../../../core/kernel/errors.mjs';
import {copying, guard} from '../../../../core/folio/lib/edit-needs.mjs';
import {viewSize, pageRotation} from '../../../../core/folio/lib/geom.mjs';
import {stem, writeOther, writeState} from '../../../../core/folio/lib/page-files.mjs';
import {currentPage} from '../../../../core/folio/commands/page.mjs';
import {postscript} from '../../../../core/folio/lib/export-more.mjs';
import {acquire, release, raster} from '../surface/pdf';

const UPSTREAM = {repo: 'printcraft' as const, commit: '8f16855', files: ['crates/engine/src/commands.rs']};
const MAX_PIXELS = 30_000_000;
const NOTE = 'The pages are written as pictures: the text is not kept as text and the fonts are not embedded.';
const both = (a: any, b: any) => (ctx: any) => { const x = a(ctx); return x.enabled ? b(ctx) : x; };
const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number) => new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('the page could not be encoded'))), type, quality));

async function drawn(ctx: any, list: number[], dpi: number) {
  const source = acquire(ctx.doc.sourceBase64);
  const out: {width: number; height: number; jpeg: Uint8Array; pixelWidth: number; pixelHeight: number}[] = [];
  try {
    for (const i of list) {
      const page = ctx.doc.pages[i];
      const {width, height} = viewSize(page);
      let scale = dpi / 72;
      const cap = Math.sqrt(MAX_PIXELS / Math.max(1, width * height));
      if (scale > cap) scale = cap;
      const canvas = await raster(source, page.sourceIndex, pageRotation(page), scale, new Set(), new AbortController().signal);
      const jpeg = new Uint8Array(await (await toBlob(canvas, 'image/jpeg', 0.9)).arrayBuffer());
      out.push({width, height, jpeg, pixelWidth: canvas.width, pixelHeight: canvas.height});
    }
  } finally { release(source); }
  return out;
}

const check = (ctx: any, pages: number[]) => {
  const bad = pages.find(i => i >= ctx.doc.pages.length);
  if (bad !== undefined) throw new CommandError('not_found', `page ${bad + 1} does not exist`, {path: '/pages'});
};

export default defineCommands({
  family: 'export_postscript',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'export.ps', label: 'Export to PostScript…', risk: 'read', undo: 'none', needs: 'view',
      description: `Export the pages as a PostScript Level 2 file named "<document>.ps": \`dpi\` 36 to 600 (default 150), \`pages\` 0-based (default all). ${NOTE} From the window the file goes where the Save dialog says; a program gets it as base64. The document must allow copying its content. Not checked against upstream.`,
      params: s.object({dpi: s.optional(s.number({min: 36, max: 600})), pages: s.optional(s.array(s.integer({min: 0, max: 99999}), {min: 1, max: 10000})), path: s.optional(s.string({min: 1, max: 4096}))}),
      state: both(copying, writeState),
      async run(ctx: any, p: any) {
        guard(ctx, copying);
        const list: number[] = p.pages ?? ctx.doc.pages.map((_: unknown, i: number) => i);
        check(ctx, list);
        const title = stem(ctx.doc.sourceName || ctx.file?.title || 'Document');
        const bytes = postscript(await drawn(ctx, list, p.dpi ?? 150), {title});
        const name = `${title}.ps`;
        const out = await writeOther(ctx, {path: p.path}, bytes, {title: 'Export', name, filters: [{name: 'PostScript', extensions: ['ps']}]});
        if (out.canceled) return {canceled: true};
        return {...out, name, pages: list.length, note: NOTE, message: out.path ? `Exported to ${out.path}` : `Exported ${name}`};
      },
    },
    {
      id: 'export.eps', label: 'Export to Encapsulated PostScript…', risk: 'read', undo: 'none', needs: 'view',
      description: `Export one page as Encapsulated PostScript named "<document>.eps": \`page\` 0-based (default the current page), \`dpi\` 36 to 600 (default 150). ${NOTE} The document must allow copying its content. Not checked against upstream.`,
      params: s.object({dpi: s.optional(s.number({min: 36, max: 600})), page: s.optional(s.integer({min: 0, max: 99999})), path: s.optional(s.string({min: 1, max: 4096}))}),
      state: both(copying, writeState),
      async run(ctx: any, p: any) {
        guard(ctx, copying);
        const i: number = p.page ?? currentPage(ctx);
        check(ctx, [i]);
        const title = stem(ctx.doc.sourceName || ctx.file?.title || 'Document');
        const bytes = postscript(await drawn(ctx, [i], p.dpi ?? 150), {title, eps: true});
        const name = `${title}.eps`;
        const out = await writeOther(ctx, {path: p.path}, bytes, {title: 'Export', name, filters: [{name: 'Encapsulated PostScript', extensions: ['eps']}]});
        if (out.canceled) return {canceled: true};
        return {...out, name, page: i, note: NOTE, message: out.path ? `Exported to ${out.path}` : `Exported ${name}`};
      },
    },
  ],
});
