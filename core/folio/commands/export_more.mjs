// Export a PDF > Spreadsheet (.xlsx) and XML 1.0, written through the system Save dialog (or to `path`; a program gets the file as base64).
//
// Not checked against upstream: printcraft at 8f16855 plans Spreadsheet (catalog.rs, M10) and has no XML, so both follow Acrobat's Export a PDF (lib/export-more.mjs says
// how): the tables the page text lays out (the ones Export to Word detects) become sheets, XML is the text with its structure. Like every export here the document must
// allow copying its content, and the file is named "<document>.<ext>" in the Save dialog. PostScript and EPS draw the pages: src/apps/folio/ui-commands/export-postscript.ts.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/export-more.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {copying, guard} from '../lib/edit-needs.mjs';
import {writeOther, writeState, stem} from '../lib/page-files.mjs';
import {exportPages} from './export.mjs';
import * as more from '../lib/export-more.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/workflows/files.rs', 'crates/export/src/layout.rs']};
const both = (...states) => ctx => { for (const f of states) { const st = f(ctx); if (!st.enabled) return st; } return {enabled: true}; };
const enc = new TextEncoder();

function exporter(ext, label, build, description) {
  return {
    id: `export.${ext}`, label: `Export to ${label}`, risk: 'read', undo: 'none', needs: 'worker', description,
    params: s.object({path: s.optional(s.string({min: 1, max: 4096, description: `Where to write the .${ext}`}))}),
    state: both(copying, writeState),
    async run(ctx, p) {
      guard(ctx, copying);
      const title = stem(ctx.doc.sourceName || ctx.file?.title || 'Document');
      const name = `${title}.${ext}`;
      const list = await exportPages(ctx.doc);
      const bytes = await build(list, title);
      const out = await writeOther(ctx, {path: p.path}, bytes, {title: 'Export', name, filters: [{name: ext.toUpperCase(), extensions: [ext]}]});
      if (out.canceled) return {canceled: true};
      return {...out, name, pages: list.length, ...(ext === 'xlsx' ? {sheets: more.sheetsOf(list).map(x => x.name)} : {}), message: out.path ? `Exported to ${out.path}` : `Exported ${name}`};
    },
  };
}

export default defineCommands({
  family: 'export_more',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    exporter('xlsx', 'Spreadsheet (.xlsx)', pages => more.xlsx(pages),
      'Export the document as a workbook: each table the page text lays out is a sheet (numbers are stored as numbers, a cell that spans columns is merged); a document with no table puts its paragraphs in one sheet, a row each. The document must allow copying its content. Not checked against upstream.'),
    exporter('xml', 'XML 1.0 (.xml)', (pages, title) => enc.encode(more.xml(pages, title)),
      'Export the document as XML 1.0: a document element with a page element each holding its headings, paragraphs and tables in reading order (text only; the tags are not read). The document must allow copying its content. Not checked against upstream.'),
  ],
});
