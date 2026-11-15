// The document file lifecycle for every app: New, Open, Save, Save As, Save a Copy, Close, AutoSave,
// Rename, Properties, Print, Recover — every document is a real file on disk, as in Office.
//
// Translated from wordcraft crates/engine/src/cmd/file.rs (file.new, file.open, file.save,
// file.saveAs, file.rename, file.close, file.print, file.properties) and
// crates/engine/src/cmd/tools/specs.rs (file.autosave, file.recover), with the UI flow of
// crates/ui-egui/src/app/files.rs (Save Changes prompt, AutoSave blocks, AutoSave tick) and
// crates/ui-egui/src/state.rs (keeps_everything), at aadb077e072b7de05f724e359d8db82e151f125c;
// the parameter names gridcraft (146161b, crates/engine/src/cmd/file.rs) and deckcraft (f893f6a,
// crates/engine/src/cmd/file.rs) use (file.save {path, format}, file.close {force}); the recent
// list of deckcraft crates/ui-egui/src/backstage/files.rs; and printcraft (3109bb2)
// file.save_as / file.open_recent / file.clear_recent / file.close_all ids. Where ArtCraft and
// Office differ on what a lossy Save As binds to, Office wins (docs/behaviour-fidelity.md): Save As
// a format this app can read back (.txt, .csv) binds the document to the new file after Office's
// warning; a format it cannot read back (.html, .pdf from a document) is written as a copy.
// MIT, see assets/third-party-licenses/artcraft-reference.txt.
//
// Persistence goes through the Host's file service (`host.files`, core/kernel/host.d.mts): the
// main process writes through the format worker (temp file + rename) and keeps each document's
// binding (path, format, AutoSave). Programmatic calls (origin 'bridge') never open dialogs: a
// missing path is an error naming it. A host without a file service (Slate's notebooks, kernel
// tests) keeps the library behaviour: `host.save` persists the document where it lives.

import {defineCommands} from '../../kernel/command.mjs';
import {s} from '../../kernel/schema.mjs';
import {CommandError} from '../../kernel/errors.mjs';

// ---------------------------------------------------------------------------------------------
// File types (what the format worker really reads and writes for each app, schema 1)

/**
 * Save types in the order the Save As dialog lists them, native format first. `bind`: the app
 * reads the format back, so Save As binds the document to the new file (Office); otherwise the
 * file is a copy. `keeps`: the format keeps everything (AutoSave writes only these). `warn`: the
 * Office message box shown before writing a lossy format.
 */
export const FILE_TYPES = Object.freeze({
  quill: Object.freeze({
    noun: 'document', product: 'Quill', untitled: 'Document',
    save: [
      // Word's "Save as type" order: Word Document, PDF, Web Page, Plain Text.
      {format: 'docx', label: 'Word Document', exts: ['docx'], bind: true, keeps: true},
      {format: 'pdf', label: 'PDF', exts: ['pdf'], bind: false, keeps: false},
      {format: 'html', label: 'Web Page', exts: ['htm', 'html'], bind: false, keeps: false},
      {format: 'txt', label: 'Plain Text', exts: ['txt'], bind: true, keeps: false, warn: 'fileConversion'},
    ],
    open: [
      {label: 'All Word Documents', exts: ['docx']},
      {label: 'Web Pages', exts: ['htm', 'html']},
      {label: 'Text Files', exts: ['txt']},
      {label: 'Markdown', exts: ['md']},
    ],
  }),
  grid: Object.freeze({
    noun: 'workbook', product: 'Grid', untitled: 'Book',
    save: [
      {format: 'xlsx', label: 'Excel Workbook', exts: ['xlsx'], bind: true, keeps: true},
      {format: 'csv', label: 'CSV (Comma delimited)', exts: ['csv'], bind: true, keeps: false, warn: 'csv'},
      {format: 'html', label: 'Web Page', exts: ['htm', 'html'], bind: false, keeps: false},
      {format: 'pdf', label: 'PDF', exts: ['pdf'], bind: false, keeps: false},
    ],
    open: [
      {label: 'All Excel Files', exts: ['xlsx']},
      {label: 'Text Files', exts: ['csv']},
    ],
  }),
  prism: Object.freeze({
    noun: 'presentation', product: 'Prism', untitled: 'Presentation',
    // PDF is written by file.exportPdf (`via`): it needs the window's slide renderer, which a format worker does not have.
    save: [
      {format: 'pptx', label: 'PowerPoint Presentation', exts: ['pptx'], bind: true, keeps: true},
      {format: 'pdf', label: 'PDF', exts: ['pdf'], bind: false, keeps: false, via: 'file.exportPdf'},
    ],
    open: [{label: 'All PowerPoint Presentations', exts: ['pptx']}],
  }),
  folio: Object.freeze({
    noun: 'document', product: 'PDF', untitled: null,
    save: [{format: 'pdf', label: 'Adobe PDF Files', exts: ['pdf'], bind: true, keeps: true}],
    open: [{label: 'Adobe PDF Files', exts: ['pdf']}],
  }),
  // Slate is OneNote: notes save into their notebook continuously; these are copies (Export).
  slate: Object.freeze({
    noun: 'note', product: 'Slate', untitled: null,
    save: [
      {format: 'docx', label: 'Word Document', exts: ['docx'], bind: false, keeps: false},
      {format: 'html', label: 'Web Page', exts: ['htm', 'html'], bind: false, keeps: false},
      {format: 'txt', label: 'Plain Text', exts: ['txt'], bind: false, keeps: false},
      {format: 'md', label: 'Markdown', exts: ['md'], bind: false, keeps: false},
    ],
    open: [{label: 'Word Documents', exts: ['docx']}, {label: 'Text Files', exts: ['txt']}, {label: 'Markdown', exts: ['md']}],
  }),
});

const typesOf = kind => {
  const t = FILE_TYPES[kind];
  if (!t) throw new CommandError('invalid_params', `Unknown application ${kind}`, {kind});
  return t;
};

/** The file's extension, lower case, without the dot ('' when none). */
export function extensionOf(path) {
  const name = baseName(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** The last path segment ('C:\\a\\Report.docx' -> 'Report.docx'). */
export function baseName(path) {
  const parts = String(path ?? '').split(/[\\/]/);
  return parts[parts.length - 1] || '';
}

/** The folder part of a path ('C:\\a\\Report.docx' -> 'C:\\a'). */
export function folderOf(path) {
  const p = String(path ?? '');
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : '';
}

/** The name without its extension ('Report.docx' -> 'Report'): how the title bar shows a file. */
export function stemOf(path) {
  const name = baseName(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/** Two paths name the same file (Windows paths compare case-insensitively, either slash). */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = p => {
    let x = String(p).replace(/\//g, '\\').replace(/\\+$/, '');
    if (/^[a-z]:\\/i.test(x) || x.startsWith('\\\\')) x = x.toLowerCase();
    return x;
  };
  return norm(a) === norm(b);
}

/** The save type for a format id or an extension ('htm' -> Web Page). */
export function saveType(kind, formatOrExt) {
  const f = String(formatOrExt ?? '').toLowerCase().replace(/^\./, '');
  return typesOf(kind).save.find(t => t.format === f || t.exts.includes(f)) ?? null;
}

/** The format a path saves as, from its extension, or null. */
export function formatForPath(kind, path) {
  return saveType(kind, extensionOf(path))?.format ?? null;
}

/** Extensions this app opens. */
export function openExtensions(kind) {
  return [...new Set(typesOf(kind).open.flatMap(t => t.exts))];
}

/** Whether the format keeps the whole document (wordcraft keeps_everything): AutoSave writes only these. */
export function keepsEverything(kind, format) {
  return !!saveType(kind, format)?.keeps;
}

const pattern = exts => exts.map(e => `*.${e}`).join(';');

/**
 * The Save As dialog's "Save as type" list (Electron `filters`): the native format first, then
 * every other format this app really writes. `first` puts that format first (the current file's).
 */
export function saveFilters(kind, {first} = {}) {
  const list = [...typesOf(kind).save];
  const i = first ? list.findIndex(t => t.format === first) : -1;
  if (i > 0) list.unshift(...list.splice(i, 1));
  return list.map(t => ({name: `${t.label} (${pattern(t.exts)})`, extensions: [...t.exts], format: t.format}));
}

/** The Open dialog's file types (Office style: "All Word Documents" first, "All Files" last). */
export function openFilters(kind) {
  const t = typesOf(kind);
  return [...t.open.map(o => ({name: `${o.label} (${pattern(o.exts)})`, extensions: [...o.exts]})), {name: 'All Files (*.*)', extensions: ['*']}];
}

/** Office's name for the n-th new document of the session: Document1, Book1, Presentation1. */
export function untitledName(kind, n) {
  const base = typesOf(kind).untitled;
  if (!base) return null;
  return `${base}${Math.max(1, Math.floor(n))}`;
}

/** Whether `kind` creates blank documents (Acrobat has no New blank; OneNote makes pages, not files). */
export function canCreate(kind) { return !!FILE_TYPES[kind]?.untitled; }

/** A file name the Save As dialog suggests: the document's name plus the format's extension. */
export function suggestedFileName(kind, name, format) {
  const t = saveType(kind, format) ?? typesOf(kind).save[0];
  const stem = String(name || typesOf(kind).untitled || 'Document').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '') || 'Document';
  return `${stem}.${t.exts[t.exts.length - 1] === 'html' ? 'html' : t.exts[0]}`;
}

// ---------------------------------------------------------------------------------------------
// AutoSave (wordcraft ui-egui state.rs AutoSaveBlock, app/files.rs autosave_block)

/** Why AutoSave can't cover the document, or null when it can. */
export function autosaveBlock(kind, binding) {
  if (!binding?.path) return {block: 'unsaved', reason: 'Save the document to turn on AutoSave', saveAs: true};
  if (!keepsEverything(kind, binding.format)) {
    const native = typesOf(kind).save.find(t => t.keeps);
    const name = baseName(binding.path);
    return {block: 'format', saveAs: true,
      reason: `AutoSave only keeps .${native?.exts[0] ?? 'docx'} files; ${name} can't keep all formatting. Save as .${native?.exts[0] ?? 'docx'} to turn on AutoSave.`};
  }
  if (!binding.savedHere) {
    return {block: 'notSavedHere', saveAs: false,
      reason: "Save the document to turn on AutoSave (a file you have only opened isn't rewritten until you save it)"};
  }
  return null;
}

/** AutoSave writes a couple of seconds after the last change (wordcraft autosave_tick: 2.5 s). */
export const AUTOSAVE_DELAY_MS = 2500;

// ---------------------------------------------------------------------------------------------
// Office message boxes before a lossy save

/**
 * The message boxes Office shows before writing `format` (null when none). Each step is an
 * Electron-style message box: buttons in Office's order, `ok` the index that goes on, `back` the
 * index that returns to the Save As dialog (Excel's No), others cancel the save.
 */
export function lossyPrompts(kind, format, {name, sheets = 1, mode = 'saveAs'} = {}) {
  const t = saveType(kind, format);
  if (!t?.warn) return [];
  const file = `${name}.${t.exts[0]}`;
  if (t.warn === 'csv') {
    const steps = [];
    if (sheets > 1 && mode !== 'save') {
      steps.push({title: typesOf(kind).product, type: 'warning', buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1, ok: 0,
        message: 'The selected file type does not support workbooks that contain multiple sheets.',
        detail: '• To save only the active sheet, click OK.\n• To save all sheets, save them individually using a different file name for each, or choose a file type that supports multiple sheets.'});
    }
    steps.push({title: typesOf(kind).product, type: 'warning', buttons: ['Yes', 'No'], defaultId: 0, cancelId: 1, ok: 0, back: 1,
      message: `${file} may contain features that are not compatible with CSV (Comma delimited). Do you want to keep the workbook in this format?`,
      detail: '• To keep this format, which leaves out any incompatible features, click Yes.\n• To preserve the features, click No. Then save a copy in the latest Excel format.'});
    return steps;
  }
  if (t.warn === 'fileConversion' && mode !== 'save') {
    return [{title: `File Conversion - ${file}`, type: 'warning', buttons: ['OK', 'Cancel'], defaultId: 0, cancelId: 1, ok: 0,
      message: 'Warning: Saving as a text file will cause all formatting, pictures, and objects in your file to be lost.',
      detail: 'Text encoding: Unicode (UTF-8)'}];
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// The flows

const PROPERTY_KEYS = ['title', 'subject', 'author', 'keywords', 'comments', 'category', 'company', 'description', 'manager'];
const prop = s.optional(s.string({max: 2000}));
const titleOf = ctx => ctx.file?.title || 'this document';
const filesOf = ctx => (ctx.host && typeof ctx.host.files === 'object' && ctx.host.files) || null;
/** The person is at the controls (ribbon, shortcut, dialog, test): dialogs may open. */
const interactive = ctx => ctx.origin !== 'bridge';
/**
 * Opening a path reads a file into a document the caller can then read back. A path the person did not choose (not in a dialog this
 * session, not open, not recent) is asked about over the bridge, like other risky calls (security audit L5). A host without `known`
 * (a unit-test host) cannot tell, and keeps the plain read.
 */
const openRisk = (ctx, p) => {
  if (!p.path) return 'read';
  const files = filesOf(ctx);
  if (typeof files?.known !== 'function') return 'read';
  try { return files.known(p.path) ? 'read' : 'destructive'; } catch { return 'destructive'; }
};
const openSummary = (ctx, p) => (p.path ? `Open ${p.path}` : 'Open a file');
const bindingOf = ctx => {
  const files = filesOf(ctx);
  if (!files || !ctx.docId) return null;
  try { return files.binding(ctx.docId) ?? null; } catch { return null; }
};
/** The name Office shows for the document: its file's stem, else its untitled name or title. */
export function documentName(ctx) {
  const b = bindingOf(ctx);
  return b?.name || (b?.path ? stemOf(b.path) : null) || titleOf(ctx);
}
const sheetCount = ctx => (Array.isArray(ctx.doc?.sheets) ? ctx.doc.sheets.length : 1);

function needFiles(ctx) {
  const files = filesOf(ctx);
  if (!files) throw new CommandError('unavailable', 'Saving to a file is not available here');
  return files;
}

/** Show the lossy-format message boxes; 'go', 'back' (Save As again) or 'cancel'. */
async function confirmLossy(ctx, files, format, name, mode) {
  for (const step of lossyPrompts(ctx.app, format, {name, sheets: sheetCount(ctx), mode})) {
    if (typeof files.messageBox !== 'function') return 'go';
    const {ok, back, ...box} = step;
    const answer = await files.messageBox({...box, doc: ctx.docId});
    if (answer === ok) continue;
    return answer === back ? 'back' : 'cancel';
  }
  return 'go';
}

/**
 * Save, Save As or Save a Copy.
 *  save   : the document's own file when it has one in a format this app writes; else Save As.
 *  saveAs : the system Save dialog every time (UI); binds to the file when the format reads back.
 *  copy   : the dialog every time; the document stays bound to its file and keeps its state.
 * Returns {saved, path, format, bound} or {saved:false, canceled:true}.
 */
export async function saveDocument(ctx, p = {}, mode = 'save') {
  const files = needFiles(ctx);
  const kind = ctx.app;
  const binding = bindingOf(ctx) ?? {};
  const name = documentName(ctx);
  let path = p.path ?? null;
  let format = p.format ? String(p.format).toLowerCase() : null;
  if (path && !format) format = formatForPath(kind, path);
  if (path && format && !saveType(kind, format)) {
    throw new CommandError('invalid_params', `${typesOf(kind).product} can't save a ${format.toUpperCase()} file`, {path: '/format', formats: typesOf(kind).save.map(t => t.format)});
  }
  if (path && !format) {
    const exts = typesOf(kind).save.flatMap(t => t.exts.map(e => '.' + e)).join(', ');
    if (extensionOf(path)) throw new CommandError('invalid_params', `${typesOf(kind).product} can't save a .${extensionOf(path).toUpperCase()} file (${baseName(path)}): use one of ${exts}`, {path: '/path', formats: typesOf(kind).save.map(t => t.format)});
    throw new CommandError('invalid_params', `The file type could not be told from ${baseName(path) || 'the path'}: give it one of the extensions ${exts}, or pass format`, {path: '/path'});
  }
  if (path && format) {
    const ext = extensionOf(path);
    const t = saveType(kind, format);
    if (ext && !t.exts.includes(ext)) throw new CommandError('invalid_params', `${baseName(path)} does not end in .${t.exts[0]}, the ${t.label} extension`, {path: '/path'});
  }
  // Save over the document's own file, in its own format, when this app writes that format.
  if (!path && mode === 'save' && binding.path && saveType(kind, binding.format)) {
    path = binding.path;
    format = binding.format;
    if (interactive(ctx)) {
      const go = await confirmLossy(ctx, files, format, name, 'save');
      if (go === 'cancel') return {saved: false, canceled: true};
      if (go === 'back') { path = null; format = null; mode = 'saveAs'; }
    }
  }
  if (!path) {
    if (!interactive(ctx)) {
      if (mode === 'save') {
        throw new CommandError('invalid_params', binding.path
          ? `${typesOf(kind).product} can't write ${baseName(binding.path)} back in its format: pass path (where to save it, e.g. a .${typesOf(kind).save[0].exts[0]} file)`
          : `"${name}" has not been saved yet, so it has no file: pass path (where to save it, e.g. ${suggestedFileName(kind, name)})`, {path: '/path'});
      }
      throw new CommandError('invalid_params', 'path is required: programmatic calls never open the Save As dialog', {path: '/path'});
    }
    if (typeof files.pickSave !== 'function') throw new CommandError('unavailable', 'The Save As dialog is not available here');
    for (;;) {
      const picked = await files.pickSave({doc: ctx.docId, kind, mode, name, format: format ?? (saveType(kind, binding.format) ? binding.format : typesOf(kind).save[0].format)});
      if (!picked || !picked.path) return {saved: false, canceled: true};
      path = picked.path;
      format = picked.format ?? formatForPath(kind, path);
      if (!format || !saveType(kind, format)) throw new CommandError('invalid_params', `${typesOf(kind).product} can't save ${baseName(path)} in that format`, {path: '/path'});
      const go = await confirmLossy(ctx, files, format, stemOf(path), mode);
      if (go === 'go') break;
      if (go === 'cancel') return {saved: false, canceled: true};
      path = null; format = null;   // Excel's No: back to the Save As dialog
    }
  }
  const t = saveType(kind, format);
  // A format a command of the app writes (Prism's PDF needs its slide renderer): the command writes the file; the document stays as it is.
  if (t.via) {
    const r = await ctx.run(t.via, {path});
    const out = r && typeof r === 'object' && 'result' in r ? r.result : r;
    return out?.canceled ? {saved: false, canceled: true} : {saved: true, path: out?.path ?? path, format, bound: false, copy: true};
  }
  const own = samePath(path, binding.path);
  const bind = mode !== 'copy' && (t.bind || own);
  // The app may add how the document is shown (Quill: Word's w:zoom and w:view); never an edit.
  const file = typeof ctx.model?.fileForSave === 'function' ? ctx.model.fileForSave(ctx.file, ctx.view) : ctx.file;
  const written = await files.write(ctx.docId, file, {path, format, bind, mode});
  if (bind) ctx.markSaved(written?.revision);
  return {saved: true, path: written?.path ?? path, format, bound: bind, copy: !bind};
}

/** Pre-file-service hosts (library storage): Slate's notebooks and kernel tests. */
async function librarySave(ctx, p) {
  if (typeof ctx.host.save !== 'function') throw new CommandError('unavailable', 'Saving is not available here');
  const r = (await ctx.host.save(ctx.file, p)) || {};
  if (!p.path) ctx.markSaved(r.revision);
  return {saved: true, path: r.path ?? p.path ?? null, revision: r.revision ?? null};
}

const saveParams = s.object({
  path: s.optional(s.string({min: 1, max: 4096, description: 'Absolute path of the file to write (default: the document\'s own file)'})),
  format: s.optional(s.string({min: 1, max: 40, description: 'File format, e.g. docx, xlsx, pptx, pdf, csv, txt (default: from the extension)'})),
  password: s.optional(s.secret({max: 255})),
  markup: s.optional(s.boolean()),
});
const saveAsParams = s.object({
  path: s.optional(s.string({min: 1, max: 4096, description: 'Absolute path of the new file (required over the bridge)'})),
  format: s.optional(s.string({min: 1, max: 40})),
  password: s.optional(s.secret({max: 255})),
  markup: s.optional(s.boolean()),
});
/** Writing anywhere but the document's own file overwrites or creates a file others can see: ask over the bridge. */
const writeRisk = (ctx, p) => {
  if (!p.path) return 'edit';
  const files = filesOf(ctx);
  if (!files) return 'irreversible';
  return samePath(p.path, bindingOf(ctx)?.path) ? 'edit' : 'irreversible';
};
const writeSummary = verb => (ctx, p) => (p.path ? `${verb} "${documentName(ctx)}" to ${p.path}` : `Save "${documentName(ctx)}"`);
const slateRefuses = ctx => (ctx.app === 'slate' && filesOf(ctx) ? {enabled: false, reason: 'Notes save into their notebook as you write'} : {enabled: true});

function saveAsCommand(id, label, shortcut) {
  return {
    id, label, ...(shortcut ? {shortcut} : {}), risk: 'edit', effect: 'persist', undo: 'none',
    description: 'Save the document as a new file (path and format; the person picks them in the Save As dialog). The document is then that file, unless the format is one this app cannot read back (a copy).',
    params: saveAsParams,
    riskFor: (ctx, p) => (filesOf(ctx) ? writeRisk(ctx, p) : p.path ? 'irreversible' : 'edit'),
    summary: writeSummary('Save'),
    state: slateRefuses,
    async run(ctx, p) {
      if (!filesOf(ctx)) return librarySave(ctx, p);
      return saveDocument(ctx, p, 'saveAs');
    },
  };
}

/** Ask the window to show a File page (the UI request of wordcraft's push_ui_request). */
function showPage(ctx, page) {
  const files = filesOf(ctx);
  if (files && typeof files.show === 'function') { files.show(page, ctx.docId); return true; }
  return false;
}

async function openPath(ctx, path) {
  const files = needFiles(ctx);
  const r = await files.open(path, {kind: ctx.app, show: true});
  return {opened: true, doc: r.doc, path: r.path ?? path, name: r.name ?? stemOf(path), alreadyOpen: !!r.alreadyOpen};
}

// ---------------------------------------------------------------------------------------------
// The commands

export default defineCommands({
  family: 'file',
  app: '*',
  upstream: {repo: 'wordcraft', commit: 'aadb077e072b7de05f724e359d8db82e151f125c',
    files: ['crates/engine/src/cmd/file.rs', 'crates/engine/src/cmd/tools/specs.rs', 'crates/ui-egui/src/app/files.rs', 'crates/ui-egui/src/state.rs']},
  commands: [
    {
      id: 'file.save', label: 'Save', shortcut: 'Mod+S', risk: 'edit', effect: 'persist', undo: 'none',
      description: 'Save the document to its file. A new document has no file yet: pass path (the person gets the Save As dialog). With path, writes there in the format its extension or `format` names.',
      params: saveParams,
      // Writing anywhere but the document's own file overwrites a file others can see: ask over the bridge.
      riskFor: (ctx, p) => (filesOf(ctx) ? writeRisk(ctx, p) : p.path ? 'irreversible' : 'edit'),
      // With a file service the document becomes that file (gridcraft file.save {path}), as Save As
      // does; a library host (Slate's notebooks) writes a copy there and keeps the document where it lives.
      summary: (ctx, p) => writeSummary(filesOf(ctx) && ctx.app !== 'slate' ? 'Save' : 'Save a copy of')(ctx, p),
      async run(ctx, p) {
        if (!filesOf(ctx) || ctx.app === 'slate') return librarySave(ctx, p);
        return saveDocument(ctx, p, 'save');
      },
    },
    saveAsCommand('file.saveAs', 'Save As', 'F12'),
    saveAsCommand('file.save_as', 'Save as…'),
    {
      id: 'file.saveCopy', label: 'Save a Copy', risk: 'edit', effect: 'persist', undo: 'none',
      description: 'Write a copy of the document to another file; the document stays its own file with its unsaved changes.',
      params: saveAsParams,
      riskFor: (ctx, p) => (p.path ? 'irreversible' : 'edit'),
      summary: (ctx, p) => (p.path ? `Save a copy of "${documentName(ctx)}" to ${p.path}` : `Save a copy of "${documentName(ctx)}"`),
      state: ctx => (filesOf(ctx) ? {enabled: true} : {enabled: false, reason: 'Saving a copy is not available here'}),
      async run(ctx, p) { return saveDocument(ctx, p, 'copy'); },
    },
    {
      id: 'file.open', label: 'Open', risk: 'read', effect: 'persist', undo: 'none', scope: 'app',
      description: 'Open a file from disk in its own window (an open file comes forward instead). Over the bridge pass path; a file the person did not choose needs their approval.',
      riskFor: openRisk,
      summary: openSummary,
      params: s.object({path: s.optional(s.string({min: 1, max: 4096, description: 'Absolute path of the file to open'}))}),
      state: ctx => (filesOf(ctx) ? {enabled: true} : {enabled: false, reason: 'Opening files is not available here'}),
      async run(ctx, p) {
        const files = needFiles(ctx);
        let path = p.path ?? null;
        if (!path) {
          if (!interactive(ctx)) throw new CommandError('invalid_params', 'path is required: programmatic calls never open the Open dialog', {path: '/path'});
          if (typeof files.pickOpen !== 'function') throw new CommandError('unavailable', 'The Open dialog is not available here');
          path = await files.pickOpen({kind: ctx.app, doc: ctx.docId});
          if (!path) return {opened: false, canceled: true};
        }
        return openPath(ctx, path);
      },
    },
    {
      id: 'file.open_recent', label: 'Open Recent', risk: 'read', effect: 'persist', undo: 'none', scope: 'app',
      description: 'Open a file from the recent list (path), or show the list.',
      riskFor: openRisk,
      summary: openSummary,
      params: s.object({path: s.optional(s.string({min: 1, max: 4096}))}),
      state: ctx => (filesOf(ctx) ? {enabled: true} : {enabled: false, reason: 'Recent files are not available here'}),
      async run(ctx, p) {
        if (p.path) return openPath(ctx, p.path);
        if (interactive(ctx) && showPage(ctx, 'open')) return {shown: 'open'};
        return {recent: await needFiles(ctx).recent(ctx.app)};
      },
    },
    {
      id: 'file.clear_recent', label: 'Clear Recent Files', risk: 'edit', effect: 'prefs', undo: 'none', scope: 'app',
      description: 'Remove every unpinned file from the recent list (the files themselves stay where they are).',
      params: s.object({}),
      state: ctx => (filesOf(ctx) ? {enabled: true} : {enabled: false, reason: 'Recent files are not available here'}),
      async run(ctx) { return {recent: await needFiles(ctx).clearRecent(ctx.app)}; },
    },
    {
      id: 'file.new', label: 'New', risk: 'edit', effect: 'persist', undo: 'none', scope: 'app',
      description: 'A new blank document (Document1, Book1, Presentation1, ...) in its own window. It has no file until it is saved.',
      params: s.object({template: s.optional(s.enum(['blank']))}),
      state: ctx => (!filesOf(ctx) ? {enabled: false, reason: 'New documents are not available here'}
        : canCreate(ctx.app) ? {enabled: true} : {enabled: false, reason: ctx.app === 'folio' ? 'Create a PDF from a file instead' : 'Add a page or a section instead'}),
      async run(ctx) {
        const files = needFiles(ctx);
        if (!canCreate(ctx.app)) throw new CommandError('disabled', 'This app does not make blank documents');
        const r = await files.create(ctx.app, {show: interactive(ctx)});
        return {doc: r.doc, name: r.name};
      },
    },
    {
      id: 'file.rename', label: 'Rename Document', risk: 'edit', dialog: 'dialog.renameDocument',
      description: 'Rename the document: a saved document\'s file is renamed in its folder (its extension is kept); a new document is named before its first save.',
      params: s.object({name: s.string({min: 1, max: 240, trim: true})}),
      riskFor: ctx => (bindingOf(ctx)?.path ? 'irreversible' : 'edit'),
      summary: (ctx, p) => (bindingOf(ctx)?.path ? `Rename the file ${baseName(bindingOf(ctx).path)} to ${p.name}` : `Rename "${titleOf(ctx)}" to "${p.name}"`),
      async run(ctx, p) {
        const name = p.name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
        if (!name) throw new CommandError('invalid_params', 'name must not be empty', {path: '/name'});
        const binding = bindingOf(ctx);
        if (binding) {
          // wordcraft rename(): path separators, reserved characters and trailing dots are refused.
          if (name.length > 200 || /[\\/:*?"<>|]/.test(name) || /[. ]$/.test(name) || name === '.' || name === '..') {
            throw new CommandError('invalid_params', 'Enter a valid document name (up to 200 characters, without path separators).', {path: '/name'});
          }
          const r = await filesOf(ctx).rename(ctx.docId, name);
          if (binding.path) return {name: r?.name ?? name, path: r?.path ?? null};
        }
        ctx.change.setMeta('title', name);
        return {name};
      },
    },
    {
      id: 'file.close', label: 'Close', shortcut: 'Mod+W', risk: 'destructive', effect: 'persist', undo: 'none',
      description: 'Close the document. With unsaved changes pass save:true to save first (a new document then needs a file: save it with file.save {path} first) or force:true to discard them.',
      params: s.object({force: s.optional(s.boolean()), save: s.optional(s.boolean()), document: s.optional(s.boolean())}),
      riskFor: (ctx, p) => (ctx.dirty && p.force && !p.save ? 'destructive' : 'edit'),
      summary: (ctx, p) => (ctx.dirty && !p.save ? `Close "${documentName(ctx)}" and discard its unsaved changes` : `Close "${documentName(ctx)}"`),
      async run(ctx, p) {
        if (ctx.dirty && !p.save && !p.force) {
          throw new CommandError('failed', 'The document has unsaved changes: pass save:true to save them or force:true to discard them');
        }
        const files = filesOf(ctx);
        if (ctx.dirty && p.save) {
          if (files && ctx.app !== 'slate') {
            // wordcraft answer_save_changes: Save goes through Save As for a new document; a
            // cancelled or failed save cancels the close and nothing is lost.
            const r = await saveDocument(ctx, {}, 'save');
            if (!r.saved) return {closed: false, canceled: true};
          } else {
            await librarySave(ctx, {});
          }
        }
        const discard = !!(ctx.dirty && p.force && !p.save);
        if (files && typeof files.closed === 'function') await files.closed(ctx.docId, {discard});
        if (typeof ctx.host.close === 'function') await ctx.host.close(ctx.docId, {discard});
        ctx.closeAfter();
        return {closed: true};
      },
    },
    {
      id: 'file.close_all', label: 'Close all', risk: 'destructive', effect: 'persist', undo: 'none', scope: 'app',
      description: 'Close every open document of this app, asking about each one with unsaved changes.',
      params: s.object({}),
      state: ctx => (filesOf(ctx)?.closeAll ? {enabled: true} : {enabled: false, reason: 'Closing all windows is not available here'}),
      summary: () => 'Close every open document',
      async run(ctx) {
        const files = needFiles(ctx);
        if (!interactive(ctx)) throw new CommandError('unavailable', 'Close each document with documents.close {doc, save}');
        return files.closeAll();
      },
    },
    {
      id: 'file.autosave', label: 'AutoSave', risk: 'edit', effect: 'prefs', undo: 'none', scope: 'app',
      description: 'Turn AutoSave on or off for the document (toggles without `value`). AutoSave writes the document\'s own file a few seconds after each change; it needs a file in the app\'s own format, saved in this session.',
      params: s.object({value: s.optional(s.boolean())}),
      state(ctx) {
        if (!filesOf(ctx) || ctx.app === 'slate') return {enabled: true, checked: ctx.prefs.autosave !== false};
        const b = bindingOf(ctx);
        if (!b) return {enabled: false, checked: false, reason: 'No document is open'};
        const block = autosaveBlock(ctx.app, b);
        return {enabled: true, checked: !!b.autosave && !block, ...(block ? {reason: block.reason} : {})};
      },
      async run(ctx, p) {
        const files = filesOf(ctx);
        if (!files || ctx.app === 'slate') {
          const value = p.value ?? !(ctx.prefs.autosave !== false);
          ctx.updatePrefs({autosave: value});
          return {value};
        }
        let b = bindingOf(ctx);
        if (!b) throw new CommandError('not_found', 'No document is open');
        const on = p.value ?? !(b.autosave && !autosaveBlock(ctx.app, b));
        if (!on) { await files.setAutosave(ctx.docId, false); return {value: false}; }
        let block = autosaveBlock(ctx.app, b);
        if (block) {
          // Over the bridge the block is the answer; at the controls Save As (or Save) lifts it.
          if (!interactive(ctx)) throw new CommandError('failed', block.reason, {block: block.block});
          const r = await saveDocument(ctx, {}, block.saveAs ? 'saveAs' : 'save');
          if (!r.saved) return {value: false, canceled: true};
          b = bindingOf(ctx);
          block = autosaveBlock(ctx.app, b);
          if (block) throw new CommandError('failed', block.reason, {block: block.block});
        }
        await files.setAutosave(ctx.docId, true);
        return {value: true};
      },
    },
    {
      id: 'file.print', label: 'Print', risk: 'irreversible', effect: 'persist', undo: 'none',
      description: 'Print the document. At the controls without settings it shows File › Print; with settings (or over the bridge) it prints.',
      params: s.object({
        printer: s.optional(s.string({min: 1, max: 400, description: 'Printer name (default: the system default printer)'})),
        copies: s.optional(s.integer({min: 1, max: 999})),
        collate: s.optional(s.boolean()),
        pages: s.optional(s.string({min: 1, max: 200, description: '"all", or page ranges such as "1-3,5"'})),
        orientation: s.optional(s.enum(['portrait', 'landscape'])),
        paper: s.optional(s.enum(['Letter', 'Legal', 'A3', 'A4', 'A5', 'Tabloid'])),
        duplex: s.optional(s.enum(['simplex', 'longEdge', 'shortEdge'])),
        color: s.optional(s.boolean()),
      }),
      summary: (ctx, p) => `Print ${p.copies && p.copies > 1 ? `${p.copies} copies of ` : ''}"${documentName(ctx)}"${p.printer ? ` on ${p.printer}` : ''}`,
      async run(ctx, p) {
        const files = needFiles(ctx);
        if (interactive(ctx) && !Object.keys(p).length && showPage(ctx, 'print')) return {shown: 'print'};
        if (typeof files.print !== 'function') throw new CommandError('unavailable', 'Printing needs the document open in a window', {hint: 'documents.open'});
        return files.print(ctx.docId, p);
      },
    },
    {
      id: 'file.recover', label: 'Recover Unsaved Documents', risk: 'read', effect: 'persist', undo: 'none', scope: 'app',
      description: 'List the unsaved documents kept for recovery (new documents closed without saving, documents open when the app stopped), or open one (doc).',
      params: s.object({doc: s.optional(s.string({min: 1, max: 80, pattern: '^[a-zA-Z0-9_-]{1,80}$'}))}),
      state: ctx => (filesOf(ctx)?.unsaved ? {enabled: true} : {enabled: false, reason: 'Recovery is not available here'}),
      async run(ctx, p) {
        const files = needFiles(ctx);
        if (p.doc) return files.recover(p.doc, {show: interactive(ctx)});
        if (interactive(ctx) && showPage(ctx, 'recover')) return {shown: 'recover'};
        return {documents: await files.unsaved(ctx.app)};
      },
    },
    {
      id: 'file.properties', label: 'Properties', risk: 'edit',
      description: 'Read or set the document properties (title, subject, author, keywords, comments, category, company, description, custom).',
      params: s.object({
        ...Object.fromEntries(PROPERTY_KEYS.map(k => [k, prop])),
        custom: s.optional(s.record(s.nullable(s.string({max: 2000})), {max: 200})),
      }),
      run(ctx, p) {
        const before = ctx.file.properties && typeof ctx.file.properties === 'object' ? ctx.file.properties : {};
        const next = {...before};
        for (const k of PROPERTY_KEYS) if (p[k] !== undefined) next[k] = p[k];
        if (p.custom) {
          const custom = {...(before.custom || {})};
          for (const [k, v] of Object.entries(p.custom)) {
            if (!k.trim()) throw new CommandError('invalid_params', 'custom property names must not be empty', {path: '/custom'});
            if (v === null) delete custom[k]; else custom[k] = v;
          }
          next.custom = custom;
        }
        const changed = PROPERTY_KEYS.some(k => p[k] !== undefined) || p.custom !== undefined;
        if (changed) ctx.change.setMeta('properties', next);
        return {properties: next};
      },
    },
  ],
});

// ---------------------------------------------------------------------------------------------
// The Save Changes message box (registered dialogs, so the bridge sees and answers them:
// architecture section 9.4). Office's wording per app; Save runs file.close {save:true}, which
// goes through Save As for a new document; Don't Save (Acrobat: No) runs file.close {force:true}.

const SAVE_PROMPT = {
  quill: name => ({message: `Do you want to save changes to “${name}”?`, detail: ''}),
  grid: name => ({message: `Do you want to save the changes you made to “${name}”?`, detail: ''}),
  prism: name => ({message: `Do you want to save the changes you made to “${name}”?`, detail: "Your changes will be lost if you don't save them."}),
  folio: name => ({message: `Do you want to save changes to “${name}” before closing?`, detail: ''}),
};

/** The text of the Save Changes prompt for `app` and a document name. */
export function saveChangesText(app, name) {
  return (SAVE_PROMPT[app] ?? SAVE_PROMPT.quill)(name);
}

/** A Save Changes dialog model (defineDialog shape) for the id an app's spec uses. */
export function saveChangesModel(id, title) {
  const close = force => () => ({command: 'file.close', params: force ? {force: true} : {save: true}});
  return {
    id, title, command: 'file.close',
    init(ctx) {
      const name = documentName(ctx);
      return {name, ...saveChangesText(ctx.app, name)};
    },
    validate: () => [],
    buttons: {save: close(false), yes: close(false), 'dont-save': close(true), no: close(true)},
    toCommand: () => ({command: 'file.close', params: {save: true}}),
  };
}
