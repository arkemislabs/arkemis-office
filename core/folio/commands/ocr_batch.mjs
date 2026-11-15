// Scan & OCR > Recognize text > In multiple files: recognize the text of several PDFs and write a searchable copy of each, under its own name, into a
// folder the person chooses.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/commands.rs:523            ocr.recognize_batch picks the files (ocr_files_dialog)
//   crates/ui-egui/src/workflows/ocr_ui.rs:305    ocr_files / ocr_files_into: the settings showing in the dialog, a folder for the searchable files,
//                                                 each file recognized in turn, the copies written under the same names, a summary of what was done
//   crates/engine/src/ocr.rs                      OcrJob::run: pages that already contain text are skipped unless forced
// Recognition runs in the host's OCR worker only (`host.ocrWords`, else `studio.pdfOcr` in the main process: core/folio/commands/ocr.mjs `recogniser`);
// nothing here runs a recogniser of its own. A file that cannot be read, is protected or has no page needing recognition is left out and named.
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/ocr-batch.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {readOther, interactive, stem} from '../lib/page-files.mjs';
import {loadSource} from '../lib/page-source.mjs';
import {stamp} from '../lib/edit-place.mjs';
import {placeWord, textLayer, covered, ALREADY_ON_PAGE, LANGUAGES} from '../lib/ocr-layer.mjs';
import {viewToUser} from '../lib/geom.mjs';
import {pageText} from '../model/page-text.mjs';
import {createPdfContent} from '../../pdf-document.mjs';
import {migrateContent} from '../migrate.mjs';
import {writeSet, folderState} from '../lib/folder-out.mjs';
import {recogniser} from './ocr.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/workflows/ocr_ui.rs', 'crates/engine/src/ocr.rs']};
const source = s.object({path: s.optional(s.string({min: 1, max: 4096})), base64: s.optional(s.string({max: 41_000_000})), name: s.optional(s.string({max: 500}))});
const PDFS = [{name: 'Adobe PDF Files', extensions: ['pdf']}];
const MAX_FILES = 200;

/** One file: the searchable copy's bytes (or null when no page needed recognizing) and what was found. */
async function recogniseFile(bytes, name, recognise, opts) {
  const content = await migrateContent(await createPdfContent(bytes, name));
  if (!content.pages?.length) throw new Error('needs a password or has no pages');
  const doc = await loadSource(content);
  let words = 0;
  const done = [];
  for (let i = 0; i < content.pages.length; i++) {
    const page = content.pages[i];
    const existing = (await pageText(content, page)).glyphs.filter(g => g.text.trim()).map(g => g.rect);
    if (!opts.force && existing.length) continue;
    const r = await recognise(content, page, {dpi: opts.dpi, language: opts.language});
    const shown = {...page, rotation: 0};
    const fresh = [];
    for (const w of r?.words ?? []) {
      if (!String(w.text ?? '').trim()) continue;
      const box = [w.x, w.y, w.x + w.width, w.y + w.height];
      if (covered(box, existing) < ALREADY_ON_PAGE) fresh.push(placeWord(String(w.text), box, (x, y) => viewToUser(shown, x, y)));
    }
    if (!fresh.length) continue;
    stamp(doc, page.sourceIndex, 'OCR', textLayer(fresh));
    words += fresh.length; done.push(i);
  }
  return {words, pages: done, bytes: done.length ? await doc.save({updateFieldAppearances: false}) : null};
}

export default defineCommands({
  family: 'ocr_batch',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'ocr.recognize_batch', label: 'In multiple files…', risk: 'edit', effect: 'persist', undo: 'none', scope: 'app', needs: 'worker',
      description: 'Recognize text in several PDFs and write a searchable copy of each under its own name: `files` ([{path | base64, name?}]) or, from the window, PDFs picked in the system Open dialog and then a folder chosen in the system folder dialog. `language` (default en), `dpi` (default 300), `force` also recognizes pages that already have text. A file that cannot be read or needs nothing is named in `left`. Recognition runs in the OCR worker. Over the bridge nothing is written: the copies come back as base64.',
      params: s.object({
        files: s.optional(s.array(source, {max: MAX_FILES})),
        language: s.optional(s.enum(LANGUAGES.map(l => l[0])), 'en'), dpi: s.optional(s.enum([600, 300, 150, 72]), 300), force: s.optional(s.boolean(), false),
      }),
      state(ctx) {
        if (!recogniser(ctx)) return {enabled: false, reason: 'the text recognition engine is not available here'};
        return folderState(ctx);
      },
      async run(ctx, p) {
        const recognise = recogniser(ctx);
        if (!recognise) throw new CommandError('unavailable', 'the text recognition engine is not available here');
        let items = p.files;
        if (!items?.length) {
          if (!interactive(ctx)) throw new CommandError('invalid_params', 'files is required: programmatic calls never open the Open dialog', {path: '/files'});
          const f = ctx.host?.files;
          if (typeof f?.pickOpen !== 'function') throw new CommandError('unavailable', 'The Open dialog is not available here');
          const picked = await f.pickOpen({kind: ctx.app, doc: ctx.docId, title: 'Select files to recognize', filters: PDFS, multiple: true});
          items = (Array.isArray(picked) ? picked : picked ? [picked] : []).map(path => ({path}));
          if (!items.length) return {recognized: 0, canceled: true};
        }
        const made = [], left = [];
        let words = 0;
        for (const item of items) {
          let file;
          try { file = await readOther(ctx, item, {title: 'Select files to recognize', filters: PDFS}); } catch (e) { left.push(`${item.name ?? item.path ?? 'a file'} (${e.message})`); continue; }
          if (!file) continue;
          try {
            const r = await recogniseFile(file.bytes, file.name, recognise, {dpi: p.dpi, language: p.language, force: p.force});
            if (!r.bytes) { left.push(`${file.name} (no page needed recognizing)`); continue; }
            made.push({name: `${stem(file.name)}.pdf`, bytes: r.bytes}); words += r.words;
          } catch (e) { left.push(`${file.name} (${e.message})`); }
        }
        if (!made.length) return {recognized: 0, left, message: 'No text was recognized'};
        const out = await writeSet(ctx, made, {title: 'Choose a folder for the searchable files'});
        if (out.canceled) return {recognized: 0, canceled: true};
        const n = made.length;
        return {recognized: n, words, names: out.written, left, ...(out.files ? {files: out.files} : {folder: out.folder}),
          message: `Recognized ${words} word${words === 1 ? '' : 's'} in ${n} file${n === 1 ? '' : 's'}${out.folder ? ` to ${out.folder}` : ''}`};
      },
    },
  ],
});
