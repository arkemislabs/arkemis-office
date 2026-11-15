// The headless host (docs/architecture.md section 15.4): a main-process Session per app over the
// document store, for bridge requests on documents no window has live. It runs the same commands
// through the same kernel as the renderer (host.kind 'headless': worker available, no view),
// writes every committed change back with the store's revision check (the working copy, an
// AutoRecover snapshot), and answers the main-side document methods (documents.list/create/open/
// close/delete). With a file service (electron/store.cjs createFiles) documents are real files:
// documents.create makes Document1, documents.open {path} reads a file, file.save writes it, and
// documents.list reports each document's path and the recent files. See docs/bridge-protocol.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSession} from '../core/kernel/session.mjs';
import {buildRegistry} from '../core/kernel/registry.mjs';
import {createHost} from '../core/kernel/host.mjs';
import {CommandError, toCommandError} from '../core/kernel/errors.mjs';
import {ApprovalStore} from '../core/kernel/risk.mjs';
import {ADDRESS_GRAMMAR_VERSION} from '../core/kernel/address.mjs';
import {APP_IDS} from '../core/kernel/command.mjs';
import {s, parse} from '../core/kernel/schema.mjs';
import {createRpcMethods, DOC_ID_PATTERN} from '../core/kernel/rpc-methods.mjs';
import {migrateOnOpen} from '../core/kernel/open-migrate.mjs';

export const PROTOCOL = 2;
export const BRIDGE_EVENTS = Object.freeze(['doc.changed', 'doc.saved', 'selection.changed', 'document.opened', 'document.closed',
  'dialog.opened', 'dialog.closed']);
export const LIMITS = Object.freeze({bodyBytes: 16 * 1024 * 1024, rpcBatch: 100, batchSteps: 1000, readBytes: 8 * 1024 * 1024,
  rendererTimeoutMs: 30_000, approvalTtlMs: 5 * 60 * 1000});

const here = path.dirname(fileURLToPath(import.meta.url));
const doc = s.string({min: 1, max: 80, pattern: DOC_ID_PATTERN});
const kind = s.enum(APP_IDS);
const PARAMS = {
  'app.describe': s.object({}),
  'documents.list': s.object({kind: s.optional(kind)}),
  'documents.create': s.object({kind: s.optional(kind), title: s.optional(s.string({min: 1, max: 240, trim: true}))}),
  'documents.open': s.object({doc: s.optional(doc), path: s.optional(s.string({min: 1, max: 4096})), show: s.optional(s.boolean()),
    headless: s.optional(s.boolean())}),
  'documents.close': s.object({doc, save: s.optional(s.boolean()), approval: s.optional(s.object({nonce: s.string({min: 1, max: 200})}))}),
  'documents.delete': s.object({doc, approval: s.optional(s.object({nonce: s.string({min: 1, max: 200})}))}),
};
const SESSION_METHODS = new Set(['engine.execute', 'engine.batch', 'document.inspect', 'document.read', 'document.find',
  'document.anchor', 'selection.get', 'selection.set']);
const WINDOW_ONLY = new Set(['document.render', 'ui.inspect', 'ui.tab', 'ui.activate', 'ui.menu', 'ui.contextMenu', 'ui.dialog.open', 'ui.dialog.get', 'ui.dialog.set',
  'ui.dialog.submit', 'ui.dialog.cancel', 'ui.pane', 'ui.key', 'ui.keys', 'ui.pointer', 'ui.type', 'ui.capture']);
const TITLES = {quill: 'Untitled document', grid: 'Untitled workbook', prism: 'Untitled presentation', slate: 'Untitled note', folio: 'Untitled PDF'};

async function defaultLoadApp(app) {
  const [commands, apps] = await Promise.all([
    import(`../core/generated/${app}.commands.mjs`).catch(() => null),
    import('../core/generated/apps.mjs').catch(() => null),
  ]);
  return {modules: commands?.modules ?? [], sources: commands?.sources ?? [], foundation: apps?.apps?.[app] ?? {}};
}

async function defaultManifest() {
  try { return JSON.parse(await fs.readFile(path.join(here, '../core/generated/manifest.json'), 'utf8')); } catch { return {commands: []}; }
}

const DOC_ID = new RegExp(DOC_ID_PATTERN);
const windowNeeded = method => new CommandError('unavailable', `${method} needs the document open in a window`, {hint: 'documents.open'});

/**
 * @param {{store: {get(id: string): Promise<any>, list(): Promise<any[]>, save(file: any): Promise<any>, remove(id: string, revision: number): Promise<void>},
 *   product?: string, appVersion?: string, worker?: (op: object) => Promise<any>, beforeSave?: (file: any) => Promise<void>|void,
 *   manifest?: {commands?: any[]}, loadApp?: (app: string) => Promise<{modules: any[], sources?: string[], foundation?: any}>,
 *   now?: () => number, cacheLimit?: number, createFile?: (kind: string, title?: string) => any, files?: any,
 *   newHost?: boolean | ((kind: string) => boolean)}} opts
 *   files: the document file service (electron/store.cjs createFiles); without it documents live in the vault only.
 *   newHost: the new shell edits these documents (development/test builds): schema-1 documents are
 *   converted when opened and new ones are schema 2, as for apps whose manifest is ready.
 */
export async function createHeadlessHost({store, product = 'studio', appVersion = '0.0.0', worker, beforeSave, manifest, loadApp = defaultLoadApp,
  now = () => Date.now(), cacheLimit = 16, createFile, files, newHost = false} = {}) {
  if (!store || typeof store.get !== 'function') throw new TypeError('createHeadlessHost needs a store');
  const kinds = product === 'studio' ? [...APP_IDS] : APP_IDS.includes(product) ? [product] : [];
  if (!kinds.length) throw new TypeError(`Unknown product ${product}`);
  const commandManifest = manifest ?? await defaultManifest();
  const approvals = new ApprovalStore({now});
  const listeners = new Set();
  const apps = new Map();          // kind -> Promise<{session, methods}>
  const open = new Map();          // docId -> kind, in least-recently-used order
  const locks = new Map();         // docId -> tail promise
  const quiet = new Set();         // docIds being released (no events)
  let makeFile = createFile;

  function emit(event) {
    if (!BRIDGE_EVENTS.includes(event.type)) return;
    if (event.doc && quiet.has(event.doc)) return;
    const out = {...event, owner: 'headless'};
    for (const l of [...listeners]) { try { l(out); } catch { /* listeners never break a command */ } }
  }

  function withDoc(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return run;
  }

  function assertKind(k) {
    if (!kinds.includes(k)) {
      throw new CommandError('unavailable', `This app does not edit ${k} documents`, {hint: `Use the ${k} app`, kind: k});
    }
  }

  async function exportCopy(file, opts) {
    if (typeof worker !== 'function') throw new CommandError('unavailable', 'Saving a copy is not available here');
    if (!path.isAbsolute(opts.path)) throw new CommandError('invalid_params', 'path must be an absolute file path', {path: '/path'});
    const format = String(opts.format || path.extname(opts.path).slice(1)).toLowerCase();
    if (!/^[a-z0-9]{1,10}$/.test(format)) throw new CommandError('invalid_params', 'The file format could not be told from the path; pass format', {path: '/format'});
    await worker({operation: 'export', file: {...file, resolvedLinks: []}, format, path: opts.path});
    return {revision: null, path: opts.path};
  }

  function appFor(k) {
    assertKind(k);
    if (!apps.has(k)) {
      apps.set(k, (async () => {
        const loaded = await loadApp(k);
        const registry = buildRegistry(loaded.modules ?? [], {app: k, sources: loaded.sources ?? []});
        const host = createHost('headless', {
          ...(typeof worker === 'function' ? {worker} : {}),
          ...(files ? {files: headlessFiles} : {}),
          save: (file, opts = {}) => (opts.path ? exportCopy(file, opts) : persist(file.id, {event: false})),
          close: async () => {},
          now,
        });
        const session = createSession({app: k, registry, host, foundation: loaded.foundation ?? {}, approvals});
        session.subscribe(event => {
          if (event.type === 'document.closed') open.delete(event.doc);
          emit(event);
        });
        return {session, methods: createRpcMethods(session, {manifest: commandManifest, viewAvailable: false})};
      })());
      apps.get(k).catch(() => apps.delete(k));
    }
    return apps.get(k);
  }

  async function fileInfo(id) {
    const file = await store.get(id);
    if (!file) throw new CommandError('not_found', `Document ${id} was not found`, {doc: id});
    assertKind(file.kind);
    return file;
  }

  /** Is the new host live for `k` (its manifest is ready, or this is a new-host build)? */
  const live2 = (k, foundation) => foundation?.ready === true || (typeof newHost === 'function' ? !!newHost(k) : newHost === true);

  /** The app holding `id` open, loading the document from the store first when needed. Caller holds the lock. */
  async function ensureOpen(id) {
    if (open.has(id)) {
      const k = open.get(id);
      open.delete(id); open.set(id, k);
      return appFor(k);
    }
    const file = await fileInfo(id);
    const app = await appFor(file.kind);
    if (!app.session.docs.has(id)) {
      // A schema-1 document is converted with its app's migrate.mjs once the new host edits that app
      // (the legacy editor still needs schema 1 otherwise), and the conversion is written back.
      const foundation = app.session.foundation;
      const r = live2(file.kind, foundation) ? await migrateOnOpen(foundation, file) : {file, migrated: false};
      app.session.open(r.file, {activate: false});
      if (r.migrated) app.session.get(id).dirty = true;
    }
    open.set(id, file.kind);
    while (open.size > cacheLimit) {
      const [oldest] = open.keys();
      if (oldest === id) break;
      evict(oldest);
    }
    return app;
  }

  function evict(id) {
    const k = open.get(id);
    open.delete(id);
    if (!k) return;
    // Fire-and-forget under the document's lock: everything is saved already.
    withDoc(id, async () => {
      const app = await appFor(k);
      if (app.session.docs.has(id) && !app.session.get(id).dirty) {
        quiet.add(id);
        try { app.session.close(id); } finally { quiet.delete(id); }
      } else if (app.session.docs.has(id)) open.set(id, k);
    }).catch(() => {});
  }

  async function sessionDoc(id) {
    const k = open.get(id);
    if (!k) return null;
    const app = await appFor(k);
    return app.session.docs.has(id) ? {app, state: app.session.get(id)} : null;
  }

  /** Write a dirty document with the store's revision check. Caller holds the lock. */
  async function persist(id, {event = true} = {}) {
    const found = await sessionDoc(id);
    if (!found) return {revision: null};
    const {app, state} = found;
    if (!state.dirty) return {revision: state.storeRevision};
    const file = {...state.file, revision: state.storeRevision};
    let saved;
    try {
      if (beforeSave) await beforeSave(file);
      saved = await store.save(file);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (/conflict/i.test(message)) {
        const fresh = await store.get(id).catch(() => null);
        state.dirty = false;
        if (fresh) app.session.reload(id, fresh); else app.session.close(id);
        throw new CommandError('conflict', 'Another editor saved this document first, so the change was not kept. Read it again and retry.',
          {version: app.session.docs.has(id) ? app.session.get(id).version : null});
      }
      throw toCommandError(e);
    }
    state.storeRevision = saved.revision;
    state.dirty = false;
    if (event) emit({type: 'doc.saved', doc: id, version: state.version, storeRevision: saved.revision, origin: 'bridge'});
    return {revision: saved.revision};
  }

  const openDocuments = () => [...open].map(([id, k]) => ({doc: id, kind: k}));

  async function describeOpen() {
    const out = [];
    for (const [id, k] of open) {
      const app = await appFor(k);
      if (!app.session.docs.has(id)) continue;
      const d = app.session.get(id);
      out.push({doc: id, kind: k, title: d.file.title, version: d.version, dirty: d.dirty, storeRevision: d.storeRevision, owner: 'headless'});
    }
    return out;
  }

  const main = {
    async 'app.describe'() {
      return {product, appVersion, protocol: PROTOCOL, addressGrammar: ADDRESS_GRAMMAR_VERSION, apps: kinds, limits: LIMITS,
        documents: await describeOpen()};
    },
    async 'documents.list'(p) {
      const list = await store.list();
      const out = [];
      for (const f of list) {
        if (!kinds.includes(f.kind) || (p.kind && f.kind !== p.kind)) continue;
        const entry = {id: f.id, kind: f.kind, title: f.title, storeRevision: f.revision, updatedAt: f.updatedAt, open: false};
        if (files) {
          const b = files.binding(f.id);
          Object.assign(entry, {path: b?.path ?? null, name: b?.name ?? f.title, untitled: !b?.path, modified: b ? await files.modified(f.id) : null});
        }
        const found = open.has(f.id) ? await sessionDoc(f.id) : null;
        if (found) Object.assign(entry, {open: true, owner: 'headless', version: found.state.version});
        out.push(entry);
      }
      return files ? {documents: out, recent: (await files.recent()).filter(r => !p.kind || r.kind === p.kind)} : {documents: out};
    },
    async 'documents.create'(p) {
      const k = p.kind ?? (kinds.length === 1 ? kinds[0] : null);
      if (!k) throw new CommandError('invalid_params', 'kind is required (quill, grid, prism, folio or slate)', {path: '/kind'});
      assertKind(k);
      if (files) {
        const made = await files.create(k, {title: p.title});
        return {doc: made.doc, kind: k, title: made.file.title, name: made.name, path: null, storeRevision: made.file.revision};
      }
      if (!makeFile) {
        const model = await import('../core/model.mjs');
        // Schema 2 only once the app's foundation can create content and its new host is live;
        // until then the legacy editor needs schema 1.
        makeFile = async (kk, title) => {
          const {foundation} = await appFor(kk).then(a => ({foundation: a.session.foundation}));
          const v2 = live2(kk, foundation) && typeof foundation?.schema?.createContent === 'function';
          return model.createFile(kk, title, v2 ? {schema: 2} : {});
        };
      }
      const file = await makeFile(k, p.title || TITLES[k]);
      const saved = await store.save(file);
      return {doc: saved.id, kind: saved.kind, title: saved.title, storeRevision: saved.revision};
    },
    async 'documents.open'(p) {
      // Without a window manager (tests, or no Electron), "open" loads the document headless.
      const target = await resolveOpen(p);
      return withDoc(target.doc, async () => {
        const app = await ensureOpen(target.doc);
        const d = app.session.get(target.doc);
        const b = files ? files.binding(target.doc) : null;
        return {doc: target.doc, kind: d.file.kind, title: d.file.title, version: d.version, owner: 'headless', shown: false, live: false,
          ...(files ? {path: b?.path ?? null, name: b?.name ?? d.file.title, alreadyOpen: !!target.alreadyOpen} : {})};
      });
    },
    async 'documents.close'(p) {
      return withDoc(p.doc, async () => {
        const found = await sessionDoc(p.doc);
        if (!found) return {closed: false, doc: p.doc};
        let saved = false;
        if (found.state.dirty && p.save !== false) { await persist(p.doc); saved = true; }
        if (files) {
          // Office asks about changes the file does not have yet. Over the bridge save:true (the
          // default) writes the document's file (a new document needs file.save {path} first);
          // save:false discards them, which needs the person's approval.
          const modified = await files.modified(p.doc);
          if (modified && p.save !== false) {
            await found.app.session.execute(p.doc, 'file.save', {}, {origin: 'bridge'});
            saved = true;
          } else if (modified && p.save === false) {
            const name = files.binding(p.doc)?.name ?? found.state.file.title;
            const binding = {docId: p.doc, command: 'documents.close', params: {doc: p.doc, save: false}, version: found.state.version};
            const summary = `Close "${name}" and discard its unsaved changes`;
            if (!p.approval) throw new CommandError('approval_required', `${summary}: this needs the person's approval`, await approvals.issue({...binding, risk: 'destructive', summary}));
            await approvals.consume(p.approval.nonce, binding);
          }
          await files.closed(p.doc, {discard: !!(modified && p.save === false)});
        }
        found.app.session.close(p.doc);
        open.delete(p.doc);
        return {closed: true, doc: p.doc, saved};
      });
    },
    async 'documents.delete'(p) {
      return withDoc(p.doc, async () => {
        const file = await fileInfo(p.doc);
        const binding = {docId: p.doc, command: 'documents.delete', params: {doc: p.doc}, version: file.revision};
        const summary = `Move "${file.title}" to the trash`;
        if (!p.approval) {
          const data = await approvals.issue({...binding, risk: 'destructive', summary});
          throw new CommandError('approval_required', `${summary}: this needs the person's approval`, data);
        }
        await approvals.consume(p.approval.nonce, binding);
        const found = await sessionDoc(p.doc);
        if (found) { found.app.session.close(p.doc); open.delete(p.doc); }
        await store.remove(p.doc, file.revision);
        return {deleted: true, doc: p.doc, summary};
      });
    },
  };

  /** documents.open {doc} or {path}: a path opens the file (an open one is reused). */
  async function resolveOpen(p) {
    if (p.path !== undefined) {
      if (!files) throw new CommandError('unavailable', 'Opening files by path is not available here');
      if (p.doc !== undefined) throw new CommandError('invalid_params', 'pass doc or path, not both', {path: '/path'});
      const r = await files.open(p.path, {kind: kinds.length === 1 ? kinds[0] : undefined});
      return {doc: r.doc, alreadyOpen: r.alreadyOpen};
    }
    if (p.doc === undefined) throw new CommandError('invalid_params', 'doc or path is required', {path: '/doc'});
    if (files) {
      const f = await store.get(p.doc).catch(() => null);
      if (f && kinds.includes(f.kind)) await files.adopt(p.doc);
    }
    return {doc: p.doc, alreadyOpen: false};
  }

  // The file service as headless commands see it: no dialogs, no windows (programmatic calls).
  const headlessFiles = files ? {
    binding: id => files.binding(id),
    known: p => files.isKnownPath(p),
    write: (id, file, opts) => files.write(id, file, opts),
    open: async (p, opts = {}) => {
      const r = await files.open(p, {kind: opts.kind});
      return {doc: r.doc, path: r.path, name: r.name, alreadyOpen: r.alreadyOpen};
    },
    create: async (k, opts = {}) => { const r = await files.create(k, opts); return {doc: r.doc, name: r.name}; },
    setAutosave: (id, on) => files.setAutosave(id, on),
    rename: (id, name) => files.rename(id, name),
    recent: k => files.recent(k),
    clearRecent: k => files.clearRecent(k),
    closed: (id, opts) => files.closed(id, opts),
    unsaved: k => files.unsaved(k),
    recover: id => files.recover(id),
  } : null;

  async function call(method, params = {}) {
    try {
      if (Object.hasOwn(main, method)) return await main[method](parse(PARAMS[method], params ?? {}));
      if (WINDOW_ONLY.has(method) || method.startsWith('ui.')) throw windowNeeded(method);
      if (method === 'engine.commands') {
        const p = params ?? {};
        if (p.doc !== undefined) {
          if (typeof p.doc !== 'string' || !DOC_ID.test(p.doc)) throw new CommandError('invalid_params', 'doc must be a document id', {path: '/doc'});
          return await withDoc(p.doc, async () => (await ensureOpen(p.doc)).methods.call(method, p));
        }
        const k = typeof p.kind === 'string' ? p.kind : kinds.length === 1 ? kinds[0] : null;
        if (k) return (await appFor(k)).methods.call(method, p);
        const all = [];
        for (const kk of kinds) {
          const r = await (await appFor(kk)).methods.call(method, p);
          for (const c of r.commands) all.push({...c, app: kk});
        }
        return {app: null, commands: all};
      }
      if (SESSION_METHODS.has(method)) {
        const p = params ?? {};
        let id = p.doc;
        if ((id === undefined || id === null) && method === 'engine.execute') {
          if (kinds.length !== 1) throw new CommandError('invalid_params', 'doc is required', {path: '/doc'});
          return await (await appFor(kinds[0])).methods.call(method, p);
        }
        if (typeof id !== 'string' || !DOC_ID.test(id)) throw new CommandError('invalid_params', 'doc must be a document id', {path: '/doc'});
        return await withDoc(id, async () => {
          const app = await ensureOpen(id);
          try {
            return await app.methods.call(method, p);
          } finally {
            if (app.session.docs.has(id) && app.session.get(id).dirty) await persist(id);
          }
        });
      }
      throw new CommandError('not_found', `Unknown method ${method}`, {method});
    } catch (e) {
      throw toCommandError(e);
    }
  }

  return Object.freeze({
    product, kinds, approvals,
    call,
    has: id => open.has(id),
    openDocuments,
    describeOpen,
    fileInfo: id => fileInfo(id).then(f => ({doc: f.id, kind: f.kind, title: f.title, storeRevision: f.revision})),
    files,
    /** documents.open {path}: the document id for a file (read into the vault, or the open one). */
    resolveOpen: p => resolveOpen(p ?? {}),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    /** A window claimed the document: drop it here (it is saved already). */
    release(id) {
      if (!open.has(id)) return Promise.resolve(false);
      return withDoc(id, async () => {
        const found = await sessionDoc(id);
        if (!found) { open.delete(id); return false; }
        if (found.state.dirty) await persist(id).catch(() => {});
        quiet.add(id);
        try { found.app.session.close(id); } finally { quiet.delete(id); }
        open.delete(id);
        return true;
      });
    },
    /** Another process wrote the store: reload a clean document. */
    storeChanged(file) {
      if (!file || !open.has(file.id)) return Promise.resolve(false);
      return withDoc(file.id, async () => {
        const found = await sessionDoc(file.id);
        if (!found || found.state.dirty || found.state.storeRevision === file.revision) return false;
        found.app.session.reload(file.id, file);
        return true;
      });
    },
    storeRemoved(id) {
      if (!open.has(id)) return Promise.resolve(false);
      return withDoc(id, async () => {
        const found = await sessionDoc(id);
        if (found) found.app.session.close(id);
        open.delete(id);
        return true;
      });
    },
    /** Write every dirty document (before quitting). */
    async flush() {
      for (const id of [...open.keys()]) await withDoc(id, () => persist(id)).catch(() => {});
    },
  });
}
