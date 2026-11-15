// Create a PDF: from a file (a PDF opens, an image or a text file becomes a new PDF), from images, from several files joined into one, from
// several files into one PDF each, and a blank PDF. A new document opens in its own window and has no file until it is saved.
//
// Translated from printcraft at 8f16855 (Release 0.16.0; MIT, see assets/third-party-licenses/artcraft-reference.txt):
//   crates/ui-egui/src/commands.rs:240-246                create.file, create.multiple, create.multiple_separate, create.images, create.blank
//   crates/ui-egui/src/workflows/create_ui.rs             open_converted (an image or a text file converts to a new unsaved PDF), the image
//                                                         resolution choice (its own, 72 dpi, custom), create_blank (US Letter)
//   crates/ui-egui/src/workflows/create_multiple_ui.rs    stage_create_multiple (the files converted and joined in the order picked, one bookmark
//                                                         per file; a file that cannot be converted is left out and named) and stage_create_separate
//                                                         (one PDF per convertible source, numbered when a name is taken; a source that is already a
//                                                         PDF is left out)
//   crates/create/src/lib.rs                              blank, images, text (core/folio/lib/create.mjs)
// The separate PDFs are written into a folder the person chooses in the system folder dialog (host files.pickFolder / writeInFolder: only plain
// names, only inside that folder). Not translated: Create from the clipboard, a scanner and a web page (docs/spec/patches/folio/tools-hidden.json).
//
// Behaviour fidelity (docs/behaviour-fidelity.md): see tests/folio/create.test.mjs.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';
import {readOther, interactive, stem} from '../lib/page-files.mjs';
import {base64 as encode} from '../lib/page-source.mjs';
import {blankPdf, imagesPdf, convertToPdf, sourceKind, LETTER} from '../lib/create.mjs';
import {combineFiles} from '../lib/combine.mjs';
import {writeSet, plainName, folderState} from '../lib/folder-out.mjs';
import {createPdfContent} from '../../pdf-document.mjs';

const UPSTREAM = {repo: 'printcraft', commit: '8f16855', files: ['crates/ui-egui/src/commands.rs', 'crates/ui-egui/src/workflows/create_ui.rs',
  'crates/ui-egui/src/workflows/create_multiple_ui.rs', 'crates/create/src/lib.rs']};

const source = s.object({path: s.optional(s.string({min: 1, max: 4096})), base64: s.optional(s.string({max: 41_000_000})), name: s.optional(s.string({max: 500}))});
const PICK = [{name: 'PDF, images and text', extensions: ['pdf', 'png', 'jpg', 'jpeg', 'txt']}, {name: 'All Files (*.*)', extensions: ['*']}];
const IMAGES = [{name: 'Images', extensions: ['png', 'jpg', 'jpeg']}];
const hostFiles = ctx => ctx.host?.files ?? null;
const canCreate = ctx => typeof hostFiles(ctx)?.create === 'function';
const noHost = ctx => (!canCreate(ctx) && ctx.host?.kind === 'renderer' ? {enabled: false, reason: 'New documents are not available here'} : {enabled: true});

/** Files from the call, or (from the window) several picked in the system Open dialog. */
async function readFiles(ctx, list, {title, filters}) {
  let items = list;
  if (!items?.length) {
    if (!interactive(ctx)) throw new CommandError('invalid_params', 'files is required: programmatic calls never open the Open dialog', {path: '/files'});
    const f = hostFiles(ctx);
    if (typeof f?.pickOpen !== 'function') throw new CommandError('unavailable', 'The Open dialog is not available here');
    const picked = await f.pickOpen({kind: ctx.app, doc: ctx.docId, title, filters, multiple: true});
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    items = paths.map(path => ({path}));
  }
  const out = [];
  for (const item of items) { const file = await readOther(ctx, item, {title, filters}); if (file) out.push(file); }
  return out;
}

/** A new document from PDF bytes: in its own window with the host, else the bytes come back (bridge, tests). */
async function makeDocument(ctx, bytes, name, extra = {}) {
  const base = `${stem(name) || 'Untitled'}.pdf`;
  if (!canCreate(ctx)) return {...extra, name: base, base64: encode(bytes), created: false};
  const content = await createPdfContent(bytes, base);
  const r = await hostFiles(ctx).create(ctx.app, {title: stem(base), content, show: interactive(ctx)});
  return {...extra, doc: r.doc, name: r.name ?? base, created: true};
}

export default defineCommands({
  family: 'create',
  app: 'folio',
  upstream: UPSTREAM,
  commands: [
    {
      id: 'create.blank', label: 'Blank page', risk: 'edit', effect: 'persist', undo: 'none', scope: 'app',
      description: 'A new blank PDF in its own window (US Letter, one page; `width`, `height` in points and `pages` change that). It has no file until it is saved.',
      params: s.object({width: s.optional(s.number({min: 3, max: 14400})), height: s.optional(s.number({min: 3, max: 14400})), pages: s.optional(s.integer({min: 1, max: 10000}))}),
      state: noHost,
      async run(ctx, p) {
        const bytes = await blankPdf(p.width ?? LETTER[0], p.height ?? LETTER[1], p.pages ?? 1);
        return makeDocument(ctx, bytes, 'Untitled.pdf', {pages: p.pages ?? 1});
      },
    },
    {
      id: 'create.file', label: 'Single file', risk: 'edit', effect: 'persist', undo: 'none', scope: 'app',
      description: 'Create a PDF from one file: a PDF opens as it is; a JPEG or PNG picture becomes a one-page PDF at its own resolution and a text file becomes text pages, as a new PDF in its own window (no file until it is saved). Pass `path` or `base64`; from the window the system Open dialog asks.',
      params: source,
      state: noHost,
      async run(ctx, p) {
        const list = await readFiles(ctx, p.path || p.base64 ? [p] : null, {title: 'Create PDF from file', filters: PICK});
        const file = list[0];
        if (!file) return {created: false, canceled: true};
        const c = await convertToPdf(file.name, file.bytes);
        if (!c) throw new CommandError('invalid_params', `${file.name} is not a PDF, a JPEG or PNG picture or a text file`, {path: '/path'});
        return makeDocument(ctx, c.bytes, file.name, {kind: c.kind});
      },
    },
    {
      id: 'create.images', label: 'Create PDF from images', risk: 'edit', effect: 'persist', undo: 'none', scope: 'app', dialog: 'dialog.create-images',
      description: 'Create a PDF from pictures (JPEG, PNG), one page each in the order given, as a new PDF in its own window. `mode` sets the page size: "image" (each picture\'s own resolution, 72 dpi when it has none), "dpi72" (one point a pixel) or "custom" (`dpi`); the picture is not resampled.',
      params: s.object({files: s.optional(s.array(source, {max: 1000})), mode: s.optional(s.enum(['image', 'dpi72', 'custom'])), dpi: s.optional(s.number({min: 1, max: 1200}))}),
      state: noHost,
      async run(ctx, p) {
        const files = await readFiles(ctx, p.files, {title: 'Create PDF from images', filters: IMAGES});
        if (!files.length) return {created: false, canceled: true};
        let {mode, dpi} = p;
        if (!mode && interactive(ctx) && typeof ctx.host?.openDialog === 'function') {
          const v = await ctx.host.openDialog('dialog.create-images', {count: files.length});
          if (!v) return {created: false, canceled: true};
          mode = v.mode; dpi = Number(v.dpi) || 300;
        }
        const bytes = await imagesPdf(files.map(f => ({name: f.name, bytes: f.bytes})), {mode: mode ?? 'image', dpi: dpi ?? 72});
        return makeDocument(ctx, bytes, files.length === 1 ? files[0].name : 'Images.pdf', {pages: files.length});
      },
    },
    {
      id: 'create.multiple', label: 'Multiple files', risk: 'edit', effect: 'persist', undo: 'none', scope: 'app',
      description: 'Create one PDF from several files (PDFs, JPEG and PNG pictures, text files) joined in the order given, with one bookmark per file, as a new PDF in its own window. A file that cannot be converted is left out and named in `left`.',
      params: s.object({files: s.optional(s.array(source, {max: 1000}))}),
      state: noHost,
      async run(ctx, p) {
        const files = await readFiles(ctx, p.files, {title: 'Create PDF from multiple files', filters: PICK});
        if (!files.length) return {created: false, canceled: true};
        const parts = [], left = [];
        for (const f of files) {
          let c = null;
          try { c = await convertToPdf(f.name, f.bytes); } catch { c = null; }
          if (c) parts.push({name: f.name, bytes: c.bytes}); else left.push(f.name);
        }
        if (!parts.length) throw new CommandError('invalid_params', `Nothing could be converted${left.length ? `: ${left.join(', ')}` : ''}`, {path: '/files'});
        const r = await combineFiles(parts, {skipUnreadable: true});
        left.push(...r.skipped);
        return makeDocument(ctx, r.bytes, 'Combined.pdf', {pages: r.pages, files: r.files, left});
      },
    },
    {
      id: 'create.multiple_separate', label: 'Separate PDFs', risk: 'edit', effect: 'persist', undo: 'none', scope: 'app',
      description: 'Convert each of several pictures and text files into its own PDF, written into a folder the person chooses (the system folder dialog); a name that is taken is numbered, never replaced; a file that is already a PDF or cannot be converted is left out and named in `left`. Over the bridge nothing is written: the PDFs come back as base64.',
      params: s.object({files: s.optional(s.array(source, {max: 1000}))}),
      state: ctx => { const a = noHost(ctx); return a.enabled ? folderState(ctx) : a; },
      async run(ctx, p) {
        const files = await readFiles(ctx, p.files, {title: 'Create separate PDFs', filters: PICK});
        if (!files.length) return {created: 0, canceled: true};
        const made = [], left = [];
        for (const f of files) {
          if (sourceKind(f.name, f.bytes) === 'pdf') { left.push(`${f.name} (already a PDF)`); continue; }
          let c = null;
          try { c = await convertToPdf(f.name, f.bytes); } catch { c = null; }
          if (!c) { left.push(`${f.name} (cannot be converted)`); continue; }
          made.push({name: `${plainName(stem(f.name))}.pdf`, bytes: c.bytes});
        }
        if (!made.length) return {created: 0, left};
        const out = await writeSet(ctx, made, {title: 'Choose a folder for the PDFs'});
        if (out.canceled) return {created: 0, canceled: true};
        return {created: out.written.length, names: out.written, left, ...(out.folder ? {folder: out.folder, message: `Wrote ${out.written.length} ${out.written.length === 1 ? 'file' : 'files'} to ${out.folder}`} : {pdfs: out.files})};
      },
    },
  ],
});
