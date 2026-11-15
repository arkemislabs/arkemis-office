// File > Export > PDF: the slides, notes pages or handouts as a PDF, the handouts honouring the Handout Master's Slides Per Page.
// Translated from deckcraft crates/engine/src/cmd/file.rs (`pdf_options`: `layout: slides|notes|handouts`, `perPage` 1-9, default 6)
// at 4ce2944; the pages are laid out by core/prism/formats/pdf-write.mjs. MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// The PDF is written to a file the person picks in the system Save dialog (File > Export > Create PDF, and Save As with the PDF type), or
// to `path` when one is given; with no way to write (the bridge, tests) it comes back as base64 `data`. The slides are drawn by the
// host (`ctx.host.renderSlides`, the slide view drawn to PNG); a host without one refuses, because a PDF drawn some other way would
// not look like the slides. `perPage` defaults to the Slides Per Page chosen on the Handout Master tab (view.handoutPerPage), else 6.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {UPSTREAM_COMMIT, bad, hasDoc, base64Decode} from '../lib/shape-common.mjs';
import {exportPdf} from '../formats/pdf-write.mjs';
import {writeOther, writeState} from '../../folio/lib/page-files.mjs';
import {documentName} from '../../common/commands/file.mjs';

const UPSTREAM = {repo: 'deckcraft', commit: UPSTREAM_COMMIT, files: ['crates/engine/src/cmd/file.rs']};
const PER_PAGE = [1, 2, 3, 4, 6, 9];

const base64 = bytes => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

async function exportPdfCmd(ctx, p) {
  const cmd = 'file.exportPdf';
  const layout = p.layout ?? 'slides';
  if (!['slides', 'notes', 'handouts'].includes(layout)) throw bad(cmd, '`layout` is slides, notes or handouts');
  const perPage = p.perPage ?? ctx.view?.handoutPerPage ?? 6;
  if (!PER_PAGE.includes(perPage)) throw bad(cmd, '`perPage` is 1, 2, 3, 4, 6 or 9');
  const draw = ctx.host?.renderSlides;
  if (typeof draw !== 'function') throw new CommandError('unavailable', `${cmd}: the slides can only be drawn with the document open in a window`, {hint: 'documents.open'});
  const doc = ctx.doc;
  const render = async (index, size) => {
    const [url] = await draw(doc, [index], size.width);
    const m = /^data:[^;,]*;base64,(.*)$/.exec(String(url ?? ''));
    const image = m ? base64Decode(m[1]) : null;
    return image ? {image} : null;
  };
  const opts = {layout: layout === 'handouts' ? {kind: 'handouts', perPage} : {kind: layout}, render};
  if (Array.isArray(p.slides)) opts.slides = p.slides;
  if (p.dpi !== undefined) opts.dpi = p.dpi;
  if (typeof p.includeHidden === 'boolean') opts.includeHidden = p.includeHidden;
  const bytes = await exportPdf(doc, opts);
  const pages = (await import('pdf-lib')).PDFDocument.load(bytes).then(d => d.getPageCount());
  const info = {bytes: bytes.length, pages: await pages, layout, ...(layout === 'handouts' ? {perPage} : {})};
  // To a file: the path given, else the one the person picks. Nothing to write with (bridge, tests): the bytes come back.
  const wrote = await writeOther(ctx, p, bytes, {title: layout === 'handouts' ? 'Create Handouts' : 'Create PDF', name: `${documentName(ctx)}.pdf`,
    filters: [{name: 'PDF (*.pdf)', extensions: ['pdf']}]});
  if (wrote.canceled) return {canceled: true};
  return wrote.path ? {...info, path: wrote.path} : {...info, data: wrote.base64 ?? base64(bytes)};
}

export default defineCommands({
  family: 'export',
  app: 'prism',
  upstream: UPSTREAM,
  commands: [
    {id: 'file.exportPdf', label: 'Create PDF', risk: 'edit', effect: 'persist', undo: 'none', riskFor: (ctx, p) => (p.path ? 'irreversible' : 'edit'),
      summary: (ctx, p) => (p.path ? `Create a PDF of "${documentName(ctx)}" at ${p.path}` : `Create a PDF of "${documentName(ctx)}"`),
      state: ctx => { const st = hasDoc(ctx); return st.enabled ? writeState(ctx) : st; },
      description: '{path? (default: the Save dialog), layout?: slides|notes|handouts (default slides), perPage?: 1|2|3|4|6|9 (handouts: default the Handout Master\'s Slides Per Page, else 6), slides?: [index], dpi?, includeHidden?} → {path, pages, layout, perPage?} (no way to write: {data: base64 PDF, …}; Cancel: {canceled})',
      params: s.object({path: s.optional(s.string({min: 1, max: 4096})), layout: s.optional(s.string({max: 16})), perPage: s.optional(s.integer({min: 1, max: 9})), slides: s.optional(s.array(s.integer({min: 0}), {max: 10000})),
        dpi: s.optional(s.number({min: 36, max: 600})), includeHidden: s.optional(s.boolean())}),
      run: exportPdfCmd},
  ],
});
