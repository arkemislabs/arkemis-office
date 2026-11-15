// Scan & OCR ▸ Recognize text (in this file): read the pages' pictures and add an invisible text
// layer so the scan can be searched, selected and copied (Searchable Image (Exact)).
//
// Translated from printcraft at 3109bb2359759e24ef490e1cdbdba00722b20972 (MIT, see
// assets/third-party-licenses/artcraft-reference.txt):
//  * crates/engine/src/commands.rs:353 — ocr.recognize "Recognize text…", Needs::Modification;
//  * crates/ui-egui/src/workflows/ocr_ui.rs — the dialog (All pages / Current page / From–to,
//    Document language, Output, Downsample to, Also recognize pages that already have text) and the
//    report ("Recognized N words on M pages", pages skipped because they already contain text);
//  * crates/engine/src/ocr.rs — OcrJob::run (skip pages with text unless forced; words already on
//    the page are not added again), apply_ocr (one undo step "Recognize text"; none when no words);
//  * crates/ocr/src/lib.rs + engine/src/edit/run.rs:526 (core/folio/lib/ocr-layer.mjs).
// Recognition runs in the host's OCR worker: `host.ocrWords` (requested of the integrator in
// design note U-folio-edit-organize--integrator--file-bytes-and-ocr-host), else the renderer's
// `studio.pdfOcr` (Tesseract over the page rendered in the main process).

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {editable, commit} from '../lib/page-source.mjs';
import {stamp} from '../lib/edit-place.mjs';
import {placeWord, textLayer, covered, ALREADY_ON_PAGE, LANGUAGES} from '../lib/ocr-layer.mjs';
import {modification, guard} from '../lib/edit-needs.mjs';
import {pageText} from '../model/page-text.mjs';
import {viewToUser} from '../lib/geom.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '3109bb2359759e24ef490e1cdbdba00722b20972',
  files: ['crates/engine/src/commands.rs', 'crates/ui-egui/src/workflows/ocr_ui.rs', 'crates/engine/src/ocr.rs', 'crates/ocr/src/lib.rs', 'crates/engine/src/edit/run.rs']};

const pages = ctx => ctx.doc?.pages ?? [];

/** The host's recogniser: (content, page, {dpi, language}) → {words: [{text, x, y, width, height}]} in view points, or null. */
export function recogniser(ctx) {
  if (typeof ctx.host?.ocrWords === 'function') return (content, page, opts) => ctx.host.ocrWords(content, page.id, opts);
  const studio = globalThis.studio;
  if (typeof studio?.pdfOcr === 'function') {
    return async (content, page) => {
      try {
        const r = await studio.pdfOcr(content, page.id);
        return {words: r?.result?.words ?? []};
      } catch (e) {
        // The worker refuses to add an empty layer; for us that is a page with no words.
        if (/No recognized words/i.test(String(e?.message ?? e))) return {words: []};
        throw e;
      }
    };
  }
  return null;
}

function available(ctx) {
  const m = modification(ctx);
  if (!m.enabled) return m;
  return recogniser(ctx) ? {enabled: true} : {enabled: false, reason: 'the text recognition engine is not available here'};
}

export default defineCommands({
  family: 'ocr',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'ocr.recognize', label: 'Recognize text…', risk: 'edit', dialog: 'dialog.recognize-text', needs: 'worker',
      description: 'Recognize text on scanned pages and add an invisible, searchable text layer (pages: 0-based; default every page).',
      params: s.object({
        pages: s.optional(s.array(s.integer({min: 0, max: 99999}), {min: 1, max: 10000})),
        language: s.optional(s.enum(LANGUAGES.map(l => l[0])), 'en'),
        dpi: s.optional(s.enum([600, 300, 150, 72]), 300),
        force: s.optional(s.boolean({description: 'Also recognize pages that already have text'}), false),
      }),
      state: available,
      async run(ctx, p) {
        guard(ctx, available);
        const recognise = recogniser(ctx);
        const list = p.pages ? [...new Set(p.pages)].sort((a, b) => a - b) : pages(ctx).map((_, i) => i);
        const bad = list.find(i => i >= pages(ctx).length);
        if (bad !== undefined) throw new CommandError('not_found', `page ${bad + 1} does not exist`, {path: '/pages'});
        const found = [];
        for (const i of list) {
          const page = pages(ctx)[i];
          const own = await pageText(ctx.doc, page);
          const existing = own.glyphs.filter(g => g.text.trim()).map(g => g.rect);
          if (!p.force && existing.length) { found.push({page: i, words: [], skipped: 'the page already contains text'}); continue; }
          const r = await recognise(ctx.doc, page, {dpi: p.dpi, language: p.language});
          // The host renders the page as the file shows it (its own /Rotate, not the model's turn).
          const shown = {...page, rotation: 0};
          const fresh = [], already = [];
          for (const w of r?.words ?? []) {
            if (!String(w.text ?? '').trim()) continue;
            const box = [w.x, w.y, w.x + w.width, w.y + w.height];
            (covered(box, existing) < ALREADY_ON_PAGE ? fresh : already).push({text: String(w.text), box});
          }
          found.push({page: i, words: fresh.map(w => placeWord(w.text, w.box, (x, y) => viewToUser(shown, x, y))), already: already.length});
        }
        const withWords = found.filter(f => f.words.length);
        const words = withWords.reduce((n, f) => n + f.words.length, 0);
        if (withWords.length) {
          const {doc, content} = await editable(ctx.doc, withWords.map(f => f.page));
          for (const f of withWords) stamp(doc, content.pages[f.page].sourceIndex, 'OCR', textLayer(f.words));
          await commit(ctx, doc, content);
          ctx.setUndoLabel('Recognize text');
        }
        const skipped = found.filter(f => f.skipped).map(f => f.page);
        return {words, pages: withWords.map(f => f.page), skipped,
          message: words ? `Recognized ${words} word${words === 1 ? '' : 's'} on ${withWords.length} page${withWords.length === 1 ? '' : 's'}`
            : skipped.length === list.length ? 'Every page already contains text' : 'No text was recognized'};
      },
    },
  ],
});
