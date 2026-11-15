// Export a PDF ▸ Text (plain): the pages' text in reading order, pages separated by a form feed,
// written through the system Save dialog.
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt):
//  * crates/engine/src/commands.rs:345 — export.text "Export to text…", Needs::Copying;
//  * crates/ui-egui/src/workflows/export_ui.rs:47, 209-221 — the dialog (Pages All / Current page /
//    Range), the file "<name>.txt", the report "Exported the text of N pages";
//  * crates/engine/src/export.rs:297 `text_of` — each page's text with its trailing white space
//    trimmed, then "\n"; pages after the first start with U+000C.
// The page text is the model's (core/folio/model/page-text.mjs, printcraft's text device).
//
// Export a PDF > Word, PowerPoint, HTML and RTF (printcraft at 8f16855, Release 0.16.0):
//  * crates/ui-egui/src/commands.rs:579-582 — export.docx, .pptx, .html, .rtf call export_office_dialog;
//  * crates/ui-egui/src/workflows/files.rs `export_office_dialog` — Needs::Copying, the Save dialog titled Export with the file
//    "<name>.<ext>" in the document's folder, the file written, "Exported to <path>";
//  * crates/engine/src/compare.rs `export_pages_checked` / `export_office` — each page reduced to paragraphs and images, then
//    crates/export (lib/export-office.mjs); the paragraphs come from lib/reading-blocks.mjs.
// Not translated (docs/spec/patches/folio/export.json): pictures (a page's images are left out of the file), the page background,
// the list of pages whose forms were read only in part, and Spreadsheet (.xlsx), PostScript/EPS, Image (PNG) and Export all images
// (the catalogue lists no command for them at 8f16855 or they need the page rendered).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {pageText} from '../model/page-text.mjs';
import {copying, guard} from '../lib/edit-needs.mjs';
import {writeOther, writeState, stem} from '../lib/page-files.mjs';
import {viewSize} from '../lib/geom.mjs';
import {exportBlocks} from '../lib/reading-blocks.mjs';
import * as office from '../lib/export-office.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/workflows/export_ui.rs', 'crates/engine/src/export.rs']};

const pages = ctx => ctx.doc?.pages ?? [];
const TEXT_FILTER = [{name: 'Text (Plain)', extensions: ['txt']}];

/** export.rs `text_of`. */
export async function textOf(content, indices) {
  let out = '';
  for (let k = 0; k < indices.length; k++) {
    if (k > 0) out += '\f';
    const pt = await pageText(content, content.pages[indices[k]]);
    out += pt.plain().text.replace(/\s+$/u, '') + '\n';
  }
  return out;
}

/** engine compare.rs `export_pages_checked`: every page as paragraphs (no pictures here) with its displayed size in points. */
export async function exportPages(content) {
  const out = [];
  for (const page of content.pages) {
    const {width, height} = viewSize(page);
    out.push({width, height, blocks: exportBlocks(await pageText(content, page), height), images: [], background: null});
  }
  return out;
}

const enc = new TextEncoder();
const OFFICE = {
  docx: {label: 'Microsoft Word (.docx)', build: (pages, title) => office.docx(pages, title)},
  pptx: {label: 'Presentation (.pptx)', build: (pages, title) => office.pptx(pages, title)},
  html: {label: 'HTML web page', build: (pages, title) => enc.encode(office.html(pages, title))},
  rtf: {label: 'Rich Text Format (.rtf)', build: pages => enc.encode(office.rtf(pages))},
};

function officeExport(ext) {
  const {label, build} = OFFICE[ext];
  return {
    id: `export.${ext}`, label: `Export to ${label}`, risk: 'read', undo: 'none', needs: 'worker',
    description: `Export the document as ${label}: each page reduced to paragraphs (headings are the text set larger than the body, tables are detected from the layout) and written to \`path\`, or from the window to the file picked in the system Save dialog (named "<document>.${ext}"); a program without a path gets the file as \`base64\`. The document must allow copying its content. Pictures are not exported.`,
    params: s.object({path: s.optional(s.string({min: 1, max: 4096, description: `Where to write the .${ext}`}))}),
    state: both(copying, writeState),
    async run(ctx, p) {
      guard(ctx, copying);
      const name = `${stem(ctx.doc.sourceName || ctx.file?.title || 'Document')}.${ext}`;
      const list = await exportPages(ctx.doc);
      const bytes = await build(list, stem(ctx.doc.sourceName || ctx.file?.title || 'Document'));
      const out = await writeOther(ctx, {path: p.path}, bytes, {title: 'Export', name, filters: [{name: ext.toUpperCase(), extensions: [ext]}]});
      if (out.canceled) return {canceled: true};
      return {...out, name, pages: list.length, message: out.path ? `Exported to ${out.path}` : `Exported ${name}`};
    },
  };
}

const both = (...states) => ctx => { for (const f of states) { const st = f(ctx); if (!st.enabled) return st; } return {enabled: true}; };

export default defineCommands({
  family: 'export',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    ...Object.keys(OFFICE).map(officeExport),
    {
      id: 'export.text', label: 'Export to text…', risk: 'read', undo: 'none', dialog: 'dialog.export-text',
      description: 'Export the text of all pages, the current page or a range to a plain text file (pages separated by a form feed).',
      params: s.object({
        pages: s.optional(s.array(s.integer({min: 0, max: 99999}), {min: 1, max: 10000, description: '0-based pages (default: all)'})),
        path: s.optional(s.string({min: 1, max: 4096, description: 'Where to write the .txt (default: the Save dialog; programmatic calls get the text back)'})),
      }),
      state: both(copying, writeState),
      async run(ctx, p) {
        guard(ctx, copying);
        const list = p.pages ?? pages(ctx).map((_, i) => i);
        const bad = list.find(i => i >= pages(ctx).length);
        if (bad !== undefined) throw new CommandError('not_found', `page ${bad + 1} does not exist`, {path: '/pages'});
        const text = await textOf(ctx.doc, list);
        const name = `${stem(ctx.doc.sourceName || ctx.file?.title || 'Document')}.txt`;
        const out = await writeOther(ctx, {path: p.path}, new TextEncoder().encode(text), {title: 'Export to Text', name, filters: TEXT_FILTER});
        if (out.canceled) return {canceled: true};
        const message = list.length === 1 ? 'Exported the text of 1 page' : `Exported the text of ${list.length} pages`;
        return {...out, ...(out.path ? {} : {text}), name, pages: list.length, message};
      },
    },
  ],
});
