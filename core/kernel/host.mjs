// Host: the environment services a Session reaches the outside through
// (docs/architecture.md section 4.4). No DOM, no Node built-ins.
//
//   kind        'renderer' | 'headless' | 'test'
//   fonts()     installed fonts
//   measureText renderer only (Canvas2D)
//   worker(op)  PDF / format / OCR worker
//   pickFile, pickImage, openDialog, view   renderer only
//   clipboardRead(), clipboardWrite(data)
//   save(file, opts)        library persistence (Slate's notebooks; hosts without a file service)
//   files                   the document file service (core/kernel/host.d.mts FileService): bindings
//                           to real files, write/open through the format worker, recent files,
//                           AutoSave, recovery; renderer-only pickSave/pickOpen/messageBox/show
//   notebooks               renderer only: Slate notebooks as folders (New/Open Notebook, recent
//                           notebooks, the folder IO core/slate/lib/notebook-folder.mjs needs)
//   close(docId, opts)      close the document's window or headless handle
//   savePrefs(prefs)        persist Options and ribbon customization
//   now(), uid()
//
// Rule: a command whose params can be supplied programmatically never needs pickFile, openDialog
// or view; those exist for the UI path that gathers params first.

import {CommandError} from './errors.mjs';

export const HOST_KINDS = Object.freeze(['renderer', 'headless', 'test']);
const ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** An 8-character base36 id (the schema-2 block id shape). */
export function shortId() {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, b => ID_CHARS[b % 36]).join('');
}

const unavailable = what => () => { throw new CommandError('unavailable', `${what} is not available here`); };

/**
 * Fill a host with defaults for the services it lacks. Optional renderer-only services stay
 * undefined so commands can test for them.
 */
export function createHost(kind, services = {}) {
  if (!HOST_KINDS.includes(kind)) throw new TypeError(`Unknown host kind ${kind}`);
  let clipboard = {text: '', html: ''};
  // The renderer's file service is the preload's (window.studio.files): the main process owns
  // bindings, dialogs and the format worker. Injected by the environment, so no DOM is touched.
  const injected = kind === 'renderer' && !('files' in services) ? globalThis.studio?.files : undefined;
  // Slate notebooks as folders: the preload's window.studio.notebookFolder (electron/notebook-folders.cjs).
  const notebooks = kind === 'renderer' && !('notebooks' in services) ? globalThis.studio?.notebookFolder : undefined;
  // View › Window (New Window, Arrange All, Side by Side, Switch Windows): the preload's window.studio.windows.
  const windows = kind === 'renderer' && !('windows' in services) ? globalThis.studio?.windows : undefined;
  return {
    ...(injected && typeof injected === 'object' ? {files: injected} : {}),
    ...(notebooks && typeof notebooks === 'object' ? {notebooks} : {}),
    ...(windows && typeof windows === 'object' ? {windows} : {}),
    kind,
    fonts: async () => [],
    worker: unavailable('The document worker'),
    clipboardRead: async () => ({...clipboard}),
    clipboardWrite: async data => { clipboard = {text: String(data?.text ?? ''), html: String(data?.html ?? '')}; },
    now: () => Date.now(),
    uid: shortId,
    ...services,
  };
}

/** A deterministic host for unit tests: fixed clock you can advance, sequential ids, memory clipboard. */
export function createTestHost(overrides = {}) {
  let t = Date.UTC(2026, 9, 29, 12, 0, 0);
  let n = 0;
  const saved = [];
  const closed = [];
  let prefs = null;
  const host = createHost('test', {
    now: () => t,
    uid: () => `t${(n++).toString(36).padStart(7, '0')}`,
    save: async (file, opts = {}) => { saved.push({file, opts}); return {revision: (file.revision ?? 0) + 1, path: opts.path ?? null}; },
    close: async (docId, opts = {}) => { closed.push({docId, opts}); },
    savePrefs: async p => { prefs = structuredClone(p); },
    ...overrides,
  });
  host.advance = ms => { t += ms; };
  host.saved = saved;
  host.closed = closed;
  Object.defineProperty(host, 'savedPrefs', {get: () => prefs});
  return host;
}

const stem = p => { const n = String(p).split(/[\\/]/).pop() || ''; const i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i) : n; };
const same = (a, b) => !!a && !!b && String(a).replace(/\//g, '\\').toLowerCase() === String(b).replace(/\//g, '\\').toLowerCase();
const UNTITLED = {quill: 'Document', grid: 'Book', prism: 'Presentation'};

/**
 * An in-memory file service (FileService in host.d.mts) for unit tests: a fake disk, bindings,
 * recent files, and scripted answers for the dialogs the person would see. `script` is a queue:
 * pickSave answers {path, format} or null (Cancel), pickOpen a path or null, messageBox a button
 * index. `asked` records every dialog in order (a message box's own type is `boxType`); `written`,
 * `shown`, `printed` and `closedDocs` record effects.
 */
export function createMemoryFiles({script = [], disk = {}} = {}) {
  const files = new Map(Object.entries(disk).map(([p, v]) => [p, structuredClone(v)]));
  const bindings = new Map();
  const recent = [];
  const queue = [...script];
  const asked = [], written = [], shown = [], printed = [], closed = [];
  const counters = {};
  let n = 0;
  const next = type => {
    if (!queue.length) throw new CommandError('failed', `The test script has no answer for the ${type} dialog`);
    return queue.shift();
  };
  const touch = (path, kind) => {
    const i = recent.findIndex(r => same(r.path, path));
    const pinned = i >= 0 ? recent[i].pinned : false;
    if (i >= 0) recent.splice(i, 1);
    recent.unshift({path, name: stem(path), kind, pinned});
  };
  const service = {
    asked, written, shown, printed, closedDocs: closed, disk: files, recentList: recent,
    /** Tests: give a document a binding (as the main process does on create/open). */
    bind(doc, b) { bindings.set(doc, {doc, path: null, format: null, autosave: false, savedHere: false, ...b}); return bindings.get(doc); },
    script(...answers) { queue.push(...answers); },
    binding: doc => (bindings.has(doc) ? {...bindings.get(doc)} : null),
    async pickSave(req) { asked.push({type: 'save', ...req}); return next('Save As'); },
    async pickOpen(req) { asked.push({type: 'open', ...req}); return next('Open'); },
    async messageBox(req) { asked.push({...req, type: 'message', boxType: req?.type}); return next('message box'); },
    show(page, doc) { shown.push({page, doc}); },
    async write(doc, file, {path, format, bind, mode}) {
      files.set(path, {format, file: structuredClone(file)});
      written.push({doc, path, format, bind, mode});
      if (bind) {
        const b = bindings.get(doc) ?? {doc, autosave: false};
        bindings.set(doc, {...b, path, format, name: stem(path), savedHere: true});
        touch(path, file.kind);
      }
      return {path, format, revision: file.revision};
    },
    async open(path, {kind} = {}) {
      for (const b of bindings.values()) if (same(b.path, path)) return {doc: b.doc, path: b.path, name: b.name, alreadyOpen: true};
      const found = [...files.entries()].find(([p]) => same(p, path));
      if (!found) throw new CommandError('not_found', `Sorry, we couldn't find ${path}. Is it possible it was moved, renamed or deleted?`, {path});
      const doc = `m${++n}`;
      bindings.set(doc, {doc, kind: kind ?? found[1].file.kind, path: found[0], format: found[1].format, name: stem(found[0]), autosave: false, savedHere: false});
      touch(found[0], kind ?? found[1].file.kind);
      return {doc, path: found[0], name: stem(found[0]), alreadyOpen: false};
    },
    async create(kind) {
      counters[kind] = (counters[kind] ?? 0) + 1;
      const doc = `m${++n}`;
      const name = `${UNTITLED[kind] ?? 'Document'}${counters[kind]}`;
      bindings.set(doc, {doc, kind, path: null, format: null, name, autosave: false, savedHere: false});
      return {doc, name};
    },
    async setAutosave(doc, on) { const b = bindings.get(doc); if (b) b.autosave = !!on; return service.binding(doc); },
    async rename(doc, name) {
      const b = bindings.get(doc);
      if (!b) throw new CommandError('not_found', 'No such document');
      if (b.path) {
        const ext = b.path.match(/\.[^.\\/]+$/)?.[0] ?? '';
        const target = b.path.replace(/[^\\/]+$/,name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext);
        if (files.has(b.path)) { files.set(target, files.get(b.path)); files.delete(b.path); }
        b.path = target;
      }
      b.name = b.path ? stem(b.path) : name;
      return service.binding(doc);
    },
    async recent(kind) { return recent.filter(r => !kind || r.kind === kind).map(r => ({...r})); },
    async clearRecent(kind) { for (let i = recent.length - 1; i >= 0; i--) if (!recent[i].pinned && (!kind || recent[i].kind === kind)) recent.splice(i, 1); return service.recent(kind); },
    async closed(doc, opts) { closed.push({doc, ...opts}); },
    async closeAll() { return {closing: true}; },
    async unsaved() { return []; },
    async recover(doc) { return {doc, recovered: true}; },
    async print(doc, opts) { printed.push({doc, opts}); return {printed: true}; },
  };
  return service;
}
