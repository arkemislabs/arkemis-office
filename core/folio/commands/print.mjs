// Print pages: the pages to print (all, the current page, a range with odd or even pages and in reverse), one to a sheet at a size (fit, actual size, shrink oversized
// pages, a custom scale), several to a sheet, or a booklet, written as a PDF of the sheets through the system Save dialog.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt): crates/print (lib/print-job.mjs says what) and
// crates/ui-egui/src/workflows/print_ui/body.rs (the dialog: Pages to Print, Page Sizing & Handling). Not translated: the system printers (there is nowhere to send the sheets
// from here: the PDF prints from any viewer), Poster and Label, comments and form fields, printing as an image. The sheets are the document as Save would write it now.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/print-job.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {documentOpen} from '../lib/edit-needs.mjs';
import {writeOther, writeState, stem} from '../lib/page-files.mjs';
import {writeFolioPdf} from '../model/pdf-write.mjs';
import {PAPERS, PrintError, selectPages, buildSheets} from '../lib/print-job.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/print/src/range.rs', 'crates/print/src/settings.rs', 'crates/print/src/sheets.rs', 'crates/ui-egui/src/workflows/print_ui/body.rs']};
const both = (a, b) => ctx => { const x = a(ctx); return x.enabled ? b(ctx) : x; };
export const PAPER_NAMES = PAPERS.map(p => p[0]);

export default defineCommands({
  family: 'print',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'print.pages', label: 'Print pages…', risk: 'read', undo: 'none', needs: 'worker', dialog: 'dialog.print',
      description: 'Print pages: lay the chosen pages on sheets and write them as a PDF named "<document> (print).pdf" (`path`, or the Save dialog; a program gets the bytes as base64). `range` such as "1-3, 6; 9-7" (empty: every page; a range written backwards runs backwards) with `subset` all, odd or even and `reverse`; `handling` size (`fit` fit, actual, shrink or custom with `scale` percent), multiple (`perSheet` 2, 4, 6, 9, 16 or another number, `order` horizontal, horizontal-reversed, vertical, vertical-reversed or cut-stack, `border`) or booklet (`booklet` both, front or back sides, `binding` left or right); `paper` and `orientation`. Only the pages\' own content is printed (no comments or form fields); it does not send anything to a printer.',
      params: s.object({
        range: s.optional(s.string({max: 500})), subset: s.optional(s.enum(['all', 'odd', 'even'])), reverse: s.optional(s.boolean()),
        paper: s.optional(s.enum(PAPER_NAMES)), orientation: s.optional(s.enum(['auto', 'portrait', 'landscape'])),
        handling: s.optional(s.enum(['size', 'multiple', 'booklet'])), fit: s.optional(s.enum(['fit', 'actual', 'shrink', 'custom'])), scale: s.optional(s.number({min: 1, max: 1000})),
        perSheet: s.optional(s.integer({min: 2, max: 64})), order: s.optional(s.enum(['horizontal', 'horizontal-reversed', 'vertical', 'vertical-reversed', 'cut-stack'])), border: s.optional(s.boolean()),
        booklet: s.optional(s.enum(['both', 'front', 'back'])), binding: s.optional(s.enum(['left', 'right'])), path: s.optional(s.string({min: 1, max: 4096})),
      }),
      state: both(documentOpen, writeState),
      async run(ctx, p) {
        const count = ctx.doc.pages.length;
        let pages;
        try { pages = selectPages(count, p.range, {subset: p.subset ?? 'all', reverse: p.reverse === true}); } catch (e) { if (e instanceof PrintError) throw new CommandError('invalid_params', e.message, {path: '/range'}); throw e; }
        const source = await writeFolioPdf(ctx.doc);
        let built;
        try {
          built = await buildSheets(source, pages, {paper: p.paper ?? 'US Letter', orientation: p.orientation ?? 'auto', handling: p.handling ?? 'size', fit: p.fit ?? 'fit', scale: p.scale ?? 100,
            perSheet: p.perSheet ?? 2, order: p.order ?? 'horizontal', border: p.border === true, booklet: p.booklet ?? 'both', binding: p.binding ?? 'left'});
        } catch (e) { if (e instanceof PrintError) throw new CommandError('failed', e.message); throw e; }
        const name = `${stem(ctx.doc.sourceName || ctx.file?.title || 'Document')} (print).pdf`;
        const out = await writeOther(ctx, {path: p.path}, built.bytes, {title: 'Print to a PDF', name});
        if (out.canceled) return {canceled: true};
        return {...out, name, pages: pages.length, sheets: built.sheets, message: `${pages.length} page${pages.length === 1 ? '' : 's'} on ${built.sheets} sheet${built.sheets === 1 ? '' : 's'}${out.path ? `, saved to ${out.path}` : ''}`};
      },
    },
  ],
});
