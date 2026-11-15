// Session, DocState, transactions and versions (docs/architecture.md section 4.1).
// Types in session.d.mts. Identical in the renderer, the headless main-process host and tests.
// No DOM, no Node built-ins.

import {CommandError, toCommandError} from './errors.mjs';
import {parse as parseParams, redact, validate} from './schema.mjs';
import {createTransaction, applyOps, contentOp, invertOps} from './change.mjs';
import {UndoStack, undoLabel} from './undo.mjs';
import {AnchorTable} from './anchors.mjs';
import {createAddressing, isAnchor, format as formatAddress} from './address.mjs';
import {ApprovalStore, needsApproval, maxRisk, riskRank, canonicalJSON} from './risk.mjs';
import {createHost} from './host.mjs';

export const JOURNAL_LIMIT = 1000;
const CHANGED_LIMIT = 1000;
export const CLIPBOARD_RING = 24;
const EMPTY_SELECTION = Object.freeze({ranges: Object.freeze([]), primary: 0});

/**
 * @param {{app: string, registry: import('./registry.mjs').Registry, host?: object,
 *   foundation?: {schema?: any, address?: any, context?: any, model?: any, spec?: any, hooks?: any},
 *   prefs?: object, undoLimit?: number, approvals?: ApprovalStore}} opts
 */
export function createSession({app, registry, host, foundation = {}, prefs = {}, undoLimit, approvals} = {}) {
  if (!registry || typeof registry.get !== 'function') throw new TypeError('createSession needs a registry');
  const env = host || createHost('test');
  const addressing = createAddressing(foundation.address);
  const appApply = typeof foundation.schema?.apply === 'function' ? foundation.schema.apply : undefined;
  // An app's checks around every command that edits the document (foundation `hooks.mjs`):
  // `before(ctx, cmd, params)` may refuse it (throw) and returns what `after(ctx, cmd, params,
  // state)` needs; `after` runs on the command's result inside the same transaction, so it may
  // refuse it (nothing is committed) or add to it (one undo step). Quill: Restrict Editing and
  // tracked formatting changes, as upstream's Session::run does.
  const hooks = foundation.hooks && typeof foundation.hooks === 'object' ? foundation.hooks : null;
  const editsContent = cmd => cmd.risk !== 'read' && (cmd.effect ?? 'content') === 'content';
  const initialView = file => { try { const v = foundation.model?.initialView?.(file); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
  const listeners = new Set();
  const commitListeners = new Set();
  const journal = [];
  let queue = Promise.resolve();
  let tick = 0;
  let stateCache = {tick: -1, map: new Map()};

  const session = {
    app,
    registry,
    host: env,
    foundation,
    addressing,
    /** @type {Map<string, any>} */
    docs: new Map(),
    activeDocId: null,
    clipboard: null,
    /** The Office Clipboard ring (newest first, at most CLIPBOARD_RING entries). */
    clipboardItems: [],
    prefs: {...prefs},
    approvals: approvals || new ApprovalStore({now: () => env.now()}),
    journal,
    get tick() { return tick; },

    open(file, {activate = true, selection} = {}) {
      if (!file || typeof file !== 'object' || typeof file.id !== 'string') throw new TypeError('open() needs a file with an id');
      if (session.docs.has(file.id)) throw new CommandError('conflict', `Document ${file.id} is already open in this session`);
      const doc = {
        id: file.id,
        file,
        version: 0,
        storeRevision: Number.isSafeInteger(file.revision) ? file.revision : 0,
        undo: new UndoStack({limit: undoLimit}),
        redo: new UndoStack({limit: undoLimit}),
        selection: selection || EMPTY_SELECTION,
        anchors: new AnchorTable(),
        dirty: false,
        // The app may start the view where the file says (Quill: Word's w:zoom and w:view).
        view: {zoom: 100, fit: null, ...initialView(file)},
        lastCommand: null,
      };
      session.docs.set(file.id, doc);
      if (activate || !session.activeDocId) session.activeDocId = file.id;
      bump();
      emit({type: 'document.opened', doc: file.id, version: 0});
      return file.id;
    },
    close(docId) {
      const doc = session.docs.get(docId);
      if (!doc) return false;
      session.docs.delete(docId);
      if (session.activeDocId === docId) session.activeDocId = session.docs.keys().next().value ?? null;
      bump();
      emit({type: 'document.closed', doc: docId, version: doc.version});
      return true;
    },
    get(docId) {
      const doc = session.docs.get(docId ?? session.activeDocId);
      if (!doc) throw new CommandError('not_found', docId ? `Document ${docId} is not open` : 'No document is open', {doc: docId ?? null});
      return doc;
    },
    activate(docId) { session.get(docId); session.activeDocId = docId; bump(); },

    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    /**
     * Committed changes with their operations, for another window on the same document (View › New
     * Window): {doc, ops, label, command} per transaction, {doc, history: 'undo'|'redo', count} per
     * undo/redo, {doc, saved: true} after a save. Never sent to the bridge (events stay small).
     */
    onCommit(listener) { commitListeners.add(listener); return () => commitListeners.delete(listener); },
    /**
     * Apply what another window of the same document committed (origin 'mirror'): its operations as
     * one undo step of this window too, or the same undo/redo, so both windows keep one history.
     */
    mirror(docId, msg) { return enqueue(() => mirrorNow(session.get(docId), msg)); },

    execute(docId, id, params = {}, opts = {}) { return enqueue(() => executeNow(docId, id, params, opts)); },
    batch(docId, steps, opts = {}) { return enqueue(() => batchNow(docId, steps, opts)); },
    undo(docId, count = 1, opts = {}) { return enqueue(() => historyNow(session.get(docId), 'undo', count, opts.origin || 'ui')); },
    redo(docId, count = 1, opts = {}) { return enqueue(() => historyNow(session.get(docId), 'redo', count, opts.origin || 'ui')); },

    /** Control state for ribbon binding; memoized per tick. Never throws. */
    state(docId, id, params) {
      if (stateCache.tick !== tick) stateCache = {tick, map: new Map()};
      const key = `${docId ?? ''}\u0000${id}\u0000${params === undefined ? '' : canonicalJSON(params)}`;
      if (stateCache.map.has(key)) return stateCache.map.get(key);
      const value = computeState(docId, id, params);
      stateCache.map.set(key, value);
      return value;
    },

    setSelection(docId, selection, {origin = 'ui'} = {}) {
      const doc = session.get(docId);
      doc.selection = normalizeSelection(selection);
      bump();
      emit({type: 'selection.changed', doc: doc.id, version: doc.version, origin, selection: doc.selection});
    },

    /** Create a sticky anchor; returns "@a<n>". */
    anchor(docId, address) {
      const doc = session.get(docId);
      const ast = resolveAst(doc, address);
      addressing.resolve(doc.file.content, ast);
      return doc.anchors.create(ast);
    },
    /** Canonical address an anchor (or any address) currently points at. */
    where(docId, address) {
      const doc = session.get(docId);
      if (isAnchor(address)) {
        const e = doc.anchors.get(address);
        return e.deleted ? {deleted: true, nearest: e.nearest ? addressing.format(e.nearest) : null} : {address: addressing.format(e.ast)};
      }
      // Friendly inputs ('Sales!D3', 'page 3') come back canonical (section 14.1): the app's
      // canonical() reads the content to map names to ids; the generic one only normalizes.
      return {address: addressing.canonical(doc.file.content, address)};
    },
    resolve(docId, address) {
      const doc = session.get(docId);
      return addressing.resolve(doc.file.content, resolveAst(doc, address));
    },
    read(docId, address, as = 'json') {
      const doc = session.get(docId);
      return addressing.read(doc.file.content, resolveAst(doc, address), as);
    },

    /** A read-only command context (dialog init, previews, inspection). */
    readContext(docId, origin = 'ui') { return readCtx(session.docs.get(docId ?? session.activeDocId) || null, origin); },

    /** Contextual flags (table, picture, ...) from the app's context.mjs, for contextual tabs. */
    contextFlags(docId) {
      const doc = session.docs.get(docId ?? session.activeDocId);
      const ctxMod = foundation.context;
      if (!doc || typeof ctxMod?.evaluate !== 'function') return {};
      // The document view too: a view can bring a contextual tab (Quill's Outlining, Immersive Reader).
      try { return ctxMod.evaluate(doc.file.content, doc.selection, session.prefs, doc.view) || {}; } catch { return {}; }
    },

    /** Replace a clean document's content from the store (another process wrote it). */
    reload(docId, file) {
      const doc = session.get(docId);
      if (doc.dirty) throw new CommandError('conflict', 'The document has unsaved changes', {version: doc.version});
      doc.file = file;
      doc.version++;
      doc.storeRevision = file.revision ?? doc.storeRevision;
      doc.undo.clear(); doc.redo.clear();
      bump();
      emit({type: 'doc.changed', doc: doc.id, version: doc.version, changed: ['/'], origin: 'store', reloaded: true});
    },
  };

  function bump() { tick++; }
  function emit(event) {
    for (const l of [...listeners]) {
      try { l(event); } catch { /* a listener never breaks a commit */ }
    }
  }
  function emitCommit(msg) {
    if (msg.origin === 'mirror') return;
    for (const l of [...commitListeners]) {
      try { l(msg); } catch { /* a listener never breaks a commit */ }
    }
  }

  /** session.mirror: another window's transaction, undo/redo or save on this document. */
  async function mirrorNow(doc, msg) {
    if (!msg || typeof msg !== 'object') return {applied: false};
    if (msg.history === 'undo' || msg.history === 'redo') return historyNow(doc, msg.history, Number(msg.count) || 1, 'mirror');
    if (msg.saved) {
      doc.dirty = false;
      bump();
      emit({type: 'doc.saved', doc: doc.id, version: doc.version, storeRevision: doc.storeRevision, origin: 'mirror'});
      return {applied: true};
    }
    if (!Array.isArray(msg.ops) || !msg.ops.length) return {applied: false};
    const selectionBefore = doc.selection;
    doc.file = applyOps(doc.file, msg.ops, {appApply});
    const selectionAfter = mapSelection(doc.selection, msg.ops);
    doc.version++;
    doc.dirty = true;
    const label = typeof msg.label === 'string' ? msg.label : 'Edit';
    doc.undo.push({label, origin: 'mirror', forward: msg.ops.slice(), inverse: invertOps(msg.ops), selectionBefore, selectionAfter,
      time: env.now(), command: typeof msg.command === 'string' ? msg.command : 'mirror', versionAfter: doc.version});
    doc.redo.clear();
    doc.anchors.mapThrough(msg.ops, addressing.mapThrough);
    doc.selection = selectionAfter;
    bump();
    emit({type: 'doc.changed', doc: doc.id, version: doc.version, changed: changedAddresses(msg.ops, doc.file.content), origin: 'mirror', command: msg.command ?? 'mirror', undoLabel: label});
    return {applied: true, version: doc.version};
  }
  function enqueue(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  function normalizeSelection(sel) {
    if (!sel || !Array.isArray(sel.ranges)) return EMPTY_SELECTION;
    const ranges = sel.ranges.filter(r => r && typeof r.anchor === 'string').map(r => ({anchor: r.anchor, focus: typeof r.focus === 'string' ? r.focus : r.anchor}));
    const primary = Number.isInteger(sel.primary) && sel.primary >= 0 && sel.primary < ranges.length ? sel.primary : 0;
    return {ranges, primary};
  }

  function resolveAst(doc, address) {
    if (isAnchor(address)) {
      const e = doc.anchors.get(address);
      if (e.deleted) {
        throw new CommandError('not_found', `The content anchor ${address} pointed at was deleted`, {
          address, deleted: true, nearest: e.nearest ? addressing.format(e.nearest) : null});
      }
      return e.ast;
    }
    return addressing.parse(address);
  }

  function lookup(id) {
    const cmd = registry.get(id);
    if (!cmd) throw new CommandError('not_found', `Unknown command ${id}`, {command: id});
    return cmd;
  }

  function docFor(cmd, docId) {
    if (cmd.scope === 'app') return session.docs.get(docId ?? session.activeDocId) || null;
    return session.get(docId);
  }

  /** A context whose change API refuses writes (state, summary, riskFor). */
  function readCtx(doc, origin) {
    const refuse = () => { throw new CommandError('failed', 'state() and summary() cannot change the document'); };
    return buildCtx(doc, origin, {
      api: Object.freeze({get: () => undefined, set: refuse, delete: refuse, splice: refuse, apply: refuse, setMeta: refuse}),
      tree: doc?.file,
      readOnly: true,
    });
  }

  function buildCtx(doc, origin, tx, staged = {}) {
    const ctx = {
      app,
      docId: doc?.id ?? null,
      origin,
      host: env,
      model: foundation.model || {},
      appInfo: foundation.spec || null,
      prefs: session.prefs,
      signal: staged.signal || new AbortController().signal,
      registry,
      get doc() { return tx.tree ? tx.tree.content : null; },
      get file() { return tx.tree || null; },
      get version() { return doc?.version ?? null; },
      get selection() { return staged.selection ?? doc?.selection ?? EMPTY_SELECTION; },
      get view() { return staged.view ?? doc?.view ?? null; },
      change: tx.api,
      resolve(address) {
        if (!doc) throw new CommandError('not_found', 'No document is open');
        const ast = resolveAst(doc, address);
        return {...addressing.resolve(tx.tree.content, ast), ast, address: isAnchor(address) ? addressing.format(ast) : address};
      },
      setSelection(sel) { if (tx.readOnly) return; staged.selection = normalizeSelection(sel); },
      setView(patch) { if (tx.readOnly) return; staged.view = {...(staged.view ?? doc?.view ?? {}), ...patch}; },
      updatePrefs(patch) { if (tx.readOnly) return; staged.prefs = {...(staged.prefs ?? session.prefs), ...patch}; },
      setUndoLabel(label) { staged.undoLabel = String(label); },
      mergeUndo(key) { staged.mergeKey = String(key); },
      markSaved(revision) { staged.saved = {revision}; },
      closeAfter() { staged.close = true; },
      get dirty() { return !!doc?.dirty; },
      get clipboard() { return staged.clipboard !== undefined ? staged.clipboard : session.clipboard; },
      get clipboardItems() { return session.clipboardItems; },
      setClipboard(entry) { if (tx.readOnly) return; staged.clipboard = entry ? {...entry, time: env.now()} : null; },
      history: {
        get canUndo() { return !!doc && doc.undo.size > 0; },
        get canRedo() { return !!doc && doc.redo.size > 0; },
        get undoDepth() { return doc ? doc.undo.size : 0; },
        undoLabels: () => (doc ? doc.undo.labels() : []),
        redoLabels: () => (doc ? doc.redo.labels() : []),
        undo(n = 1) { if (!doc) return 0; const k = Math.min(n, doc.undo.size); staged.history = {kind: 'undo', count: k}; return k; },
        redo(n = 1) { if (!doc) return 0; const k = Math.min(n, doc.redo.size); staged.history = {kind: 'redo', count: k}; return k; },
        get lastCommand() { return doc?.lastCommand ?? null; },
      },
      run(id, params = {}) {
        const cmd = lookup(id);
        const p = parseParams(cmd.params, params);
        if (cmd.state) {
          const st = safeState(cmd, ctx, p);
          if (st && st.enabled === false) throw new CommandError('disabled', st.reason || `${cmd.label} is not available now`, {command: id});
        }
        staged.nested = (staged.nested || 0) + 1;
        try { return cmd.run(ctx, p); } finally { staged.nested--; }
      },
    };
    return ctx;
  }

  function safeState(cmd, ctx, params) {
    try { return cmd.state(ctx, params ?? {}) || {enabled: true}; } catch (e) { return {enabled: false, reason: toCommandError(e).message}; }
  }

  function computeState(docId, id, params) {
    const cmd = registry.get(id);
    if (!cmd) return {enabled: false, reason: `Not translated yet: ${id}`};
    const doc = cmd.scope === 'app' ? session.docs.get(docId ?? session.activeDocId) || null : session.docs.get(docId ?? session.activeDocId);
    if (!doc && cmd.scope !== 'app') return {enabled: false, reason: 'No document is open'};
    if (!cmd.state) return {enabled: true};
    let p = params ?? {};
    const v = validate(cmd.params, p, {partial: true});
    if (v.ok) p = v.value;
    return safeState(cmd, readCtx(doc, 'ui'), p);
  }

  function effectiveRisk(cmd, doc, params) {
    if (typeof cmd.riskFor !== 'function') return cmd.risk;
    try { return cmd.riskFor(readCtx(doc, 'bridge'), params) || cmd.risk; } catch { return cmd.risk; }
  }

  function summaryOf(cmd, doc, params) {
    if (typeof cmd.summary !== 'function') return cmd.label;
    try { return String(cmd.summary(readCtx(doc, 'bridge'), params)); } catch { return cmd.label; }
  }

  async function gate(doc, command, params, risk, summary, opts) {
    if (!needsApproval(risk, opts.origin)) return;
    const binding = {docId: doc?.id ?? null, command, params, version: doc?.version ?? null};
    if (!opts.approval) {
      const data = await session.approvals.issue({...binding, risk, summary});
      throw new CommandError('approval_required', `${summary}: this needs the person's approval`, data);
    }
    await session.approvals.consume(opts.approval.nonce, binding);
  }

  function changedAddresses(ops, content) {
    if (addressing.changed) {
      try { return addressing.changed(ops.map(contentOp).filter(Boolean), content).slice(0, CHANGED_LIMIT); } catch { /* fall back */ }
    }
    const seen = new Set();
    for (const op of ops) {
      if (seen.size >= CHANGED_LIMIT) break;
      const cop = contentOp(op);
      if (!cop) { seen.add('/$file/' + op.path.join('/')); continue; }
      seen.add(cop.path.length ? formatAddress({segments: cop.path.map(k => ({kind: String(k)}))}) : '/');
    }
    return [...seen];
  }

  function mapSelection(selection, ops) {
    if (!selection.ranges.length) return selection;
    const map = addr => {
      let ast;
      try { ast = addressing.parse(addr); } catch { return addr; }
      if (ast.anchor) return addr;
      for (const op of ops) {
        const cop = contentOp(op);
        if (!cop) continue;
        const next = addressing.mapThrough(cop, ast);
        if (next?.deleted) { if (!next.nearest) return null; ast = next.nearest; } else if (next) ast = next;
      }
      return addressing.format(ast);
    };
    const ranges = selection.ranges.map(r => ({anchor: map(r.anchor), focus: map(r.focus)})).filter(r => r.anchor && r.focus);
    return {ranges, primary: Math.min(selection.primary, Math.max(0, ranges.length - 1))};
  }

  /** Commit a finished transaction. Returns the ExecResult. */
  async function commit(doc, cmdLike, tx, staged, result, opts, label) {
    const origin = opts.origin;
    if (staged.history) {
      if (tx.ops.length) throw new CommandError('failed', `${cmdLike.id} cannot both change the document and step through undo`);
      const r = await historyNow(doc, staged.history.kind, staged.history.count, origin);
      return {...r, result: result == null ? r.result : {...r.result, ...result}};
    }
    if (tx.ops.length && cmdLike.undo !== 'auto') {
      throw new CommandError('failed', `${cmdLike.id} declares undo:'none' but changed the document`);
    }
    let changed = [];
    let entryLabel;
    if (doc && tx.ops.length) {
      const selectionBefore = doc.selection;
      const selectionAfter = staged.selection ?? mapSelection(doc.selection, tx.ops);
      doc.file = tx.tree;
      doc.version++;
      doc.dirty = true;
      entryLabel = undoLabel(staged.undoLabel || label, origin);
      doc.undo.push({label: entryLabel, origin, forward: tx.ops.slice(), inverse: invertOps(tx.ops), selectionBefore, selectionAfter,
        time: env.now(), command: cmdLike.id, mergeKey: staged.mergeKey, versionAfter: doc.version});
      doc.redo.clear();
      // A command that moves content out of the document (Slate: locking a password-protected section)
      // must not leave it in the undo stack, where Undo would bring it back without the password.
      if (cmdLike.clearsHistory === true) doc.undo.clear();
      doc.anchors.mapThrough(tx.ops, addressing.mapThrough);
      doc.selection = selectionAfter;
      changed = changedAddresses(tx.ops, doc.file.content);
      if (!staged.nested && cmdLike.repeatable !== false && !String(cmdLike.id).startsWith('edit.re')) {
        doc.lastCommand = {command: cmdLike.id, params: cmdLike.params ?? {}};
      }
    } else if (doc && staged.selection) {
      doc.selection = staged.selection;
    }
    if (doc && staged.view) doc.view = staged.view;
    if (staged.clipboard !== undefined) {
      session.clipboard = staged.clipboard;
      if (staged.clipboard) {
        session.clipboardItems.unshift(staged.clipboard);
        if (session.clipboardItems.length > CLIPBOARD_RING) session.clipboardItems.length = CLIPBOARD_RING;
      }
    }
    if (staged.prefs) {
      session.prefs = staged.prefs;
      if (typeof env.savePrefs === 'function') await env.savePrefs(session.prefs);
    }
    bump();
    if (doc && tx.ops.length) {
      emit({type: 'doc.changed', doc: doc.id, version: doc.version, changed, origin, command: cmdLike.id, undoLabel: entryLabel});
      emitCommit({doc: doc.id, ops: tx.ops.slice(), label: entryLabel, command: cmdLike.id, origin});
    } else if (doc && staged.selection) {
      emit({type: 'selection.changed', doc: doc.id, version: doc.version, origin, selection: doc.selection});
    }
    if (doc && staged.view) emit({type: 'view.changed', doc: doc.id, version: doc.version, view: doc.view});
    if (staged.prefs) emit({type: 'prefs.changed', prefs: session.prefs});
    if (doc && staged.saved) {
      doc.storeRevision = staged.saved.revision ?? doc.storeRevision;
      doc.dirty = false;
      emit({type: 'doc.saved', doc: doc.id, version: doc.version, storeRevision: doc.storeRevision});
      emitCommit({doc: doc.id, saved: true, origin});
    }
    if (doc && staged.close) session.close(doc.id);
    const out = {result: result === undefined ? null : result, version: doc ? doc.version : null, changed};
    if (entryLabel) out.undoLabel = entryLabel;
    if (doc && (staged.selection || tx.ops.length)) out.selection = doc.selection;
    return out;
  }

  function journalize(doc, cmd, params, origin) {
    if (cmd.journal === false) return;
    journal.push({time: env.now(), doc: doc?.id ?? null, command: cmd.id, params: redact(cmd.params, params), origin, version: doc?.version ?? null});
    if (journal.length > JOURNAL_LIMIT) journal.splice(0, journal.length - JOURNAL_LIMIT);
  }

  async function executeNow(docId, id, rawParams, opts) {
    const origin = opts.origin || 'ui';
    const cmd = lookup(id);                                                   // 1
    const params = parseParams(cmd.params, rawParams ?? {});                 // 2
    const doc = docFor(cmd, docId);
    if (opts.baseVersion !== undefined && opts.baseVersion !== null && doc && opts.baseVersion !== doc.version) {
      throw new CommandError('conflict', `The document changed (version ${doc.version}, expected ${opts.baseVersion})`, {version: doc.version});
    }                                                                          // 3
    const risk = effectiveRisk(cmd, doc, params);
    await gate(doc, id, params, risk, summaryOf(cmd, doc, params), {...opts, origin});   // 4
    const tx = doc ? createTransaction(doc.file, {appApply}) : {api: buildNullApi(), ops: [], tree: null};
    const staged = {signal: opts.signal};
    const ctx = buildCtx(doc, origin, tx, staged);
    if (cmd.state) {                                                           // 5
      const st = safeState(cmd, ctx, params);
      if (st && st.enabled === false) throw new CommandError('disabled', st.reason || `${cmd.label} is not available now`, {command: id});
    }
    let result;
    try {                                                                      // 6
      const hooked = doc && hooks && editsContent(cmd);
      const hookState = hooked && typeof hooks.before === 'function' ? hooks.before(ctx, cmd, params) : undefined;
      result = await cmd.run(ctx, params);
      if (opts.signal?.aborted) throw new CommandError('timeout', 'The command was cancelled');
      if (hooked && typeof hooks.after === 'function') hooks.after(ctx, cmd, params, hookState);
      // An app may watch every command that ran (Quill's Record Macro keeps caret and selection commands too).
      if (doc && hooks && typeof hooks.observe === 'function') hooks.observe(ctx, cmd, params);
    } catch (e) {
      throw toCommandError(e);
    }
    if (opts.dryRun) {                                                         // 8
      return {result: result === undefined ? null : result, version: doc ? doc.version : null,
        changed: doc ? changedAddresses(tx.ops, tx.tree.content) : [], dryRun: true};
    }
    journalize(doc, cmd, params, origin);
    return commit(doc, {...cmd, params}, tx, staged, result, {origin}, cmd.label);        // 7
  }

  async function batchNow(docId, steps, opts) {
    const origin = opts.origin || 'ui';
    if (!Array.isArray(steps) || !steps.length) throw new CommandError('invalid_params', 'steps must be a non-empty array', {path: '/steps'});
    if (steps.length > 1000) throw new CommandError('too_large', 'A batch has at most 1000 steps');
    const doc = session.get(docId);
    if (opts.baseVersion !== undefined && opts.baseVersion !== null && opts.baseVersion !== doc.version) {
      throw new CommandError('conflict', `The document changed (version ${doc.version}, expected ${opts.baseVersion})`, {version: doc.version});
    }
    const parsed = steps.map((step, i) => {
      if (!step || typeof step.command !== 'string') throw new CommandError('invalid_params', `steps.${i}.command is required`, {path: `/steps/${i}/command`});
      const cmd = lookup(step.command);
      if (cmd.undo !== 'auto' && cmd.risk !== 'read') throw new CommandError('invalid_params', `${cmd.id} cannot run inside a batch`, {path: `/steps/${i}/command`});
      try { return {cmd, params: parseParams(cmd.params, step.params ?? {})}; } catch (e) {
        const ce = toCommandError(e);
        throw new CommandError(ce.code, `steps.${i}: ${ce.message}`, {...(ce.data || {}), path: `/steps/${i}/params${ce.data?.path ?? ''}`});
      }
    });
    let risk = 'read';
    for (const p of parsed) risk = maxRisk(risk, effectiveRisk(p.cmd, doc, p.params));
    const summaries = parsed.filter(p => riskRank(effectiveRisk(p.cmd, doc, p.params)) >= 2).map(p => summaryOf(p.cmd, doc, p.params));
    const label = typeof opts.label === 'string' && opts.label.trim() ? opts.label.trim() : parsed[0].cmd.label;
    await gate(doc, 'batch', parsed.map(p => ({command: p.cmd.id, params: p.params})), risk,
      summaries.length ? summaries.join('; ') : label, {...opts, origin});
    const tx = createTransaction(doc.file, {appApply});
    const staged = {signal: opts.signal};
    const ctx = buildCtx(doc, origin, tx, staged);
    const results = [];
    try {
      const hooked = hooks ? parsed.filter(p => editsContent(p.cmd)) : [];
      const states = hooked.map(p => (typeof hooks.before === 'function' ? hooks.before(ctx, p.cmd, p.params) : undefined));
      for (const p of parsed) results.push(await ctx.run(p.cmd.id, p.params));
      hooked.forEach((p, i) => { if (typeof hooks.after === 'function') hooks.after(ctx, p.cmd, p.params, states[i]); });
    } catch (e) {
      throw toCommandError(e);
    }
    if (opts.dryRun) return {result: results, version: doc.version, changed: changedAddresses(tx.ops, tx.tree.content), dryRun: true};
    for (const p of parsed) journalize(doc, p.cmd, p.params, origin);
    return commit(doc, {id: 'batch', undo: 'auto', repeatable: false}, tx, staged, results, {origin}, label);
  }

  async function historyNow(doc, kind, count, origin) {
    const from = kind === 'undo' ? doc.undo : doc.redo;
    const to = kind === 'undo' ? doc.redo : doc.undo;
    const n = Math.max(0, Math.min(Number.isInteger(count) ? count : 1, from.size));
    const labels = [];
    const allOps = [];
    for (let i = 0; i < n; i++) {
      const entry = from.pop();
      const ops = kind === 'undo' ? entry.inverse : entry.forward;
      doc.file = applyOps(doc.file, ops, {appApply});
      doc.anchors.mapThrough(ops, addressing.mapThrough);
      doc.selection = (kind === 'undo' ? entry.selectionBefore : entry.selectionAfter) || EMPTY_SELECTION;
      to.push({...entry, mergeKey: undefined});
      labels.push(entry.label);
      allOps.push(...ops);
    }
    if (!n) return {result: {[kind === 'undo' ? 'undone' : 'redone']: 0, labels}, version: doc.version, changed: []};
    doc.version++;
    doc.dirty = true;
    bump();
    const changed = changedAddresses(allOps, doc.file.content);
    emit({type: 'doc.changed', doc: doc.id, version: doc.version, changed, origin, command: kind === 'undo' ? 'edit.undo' : 'edit.redo', history: kind});
    emitCommit({doc: doc.id, history: kind, count: n, origin});
    return {result: {[kind === 'undo' ? 'undone' : 'redone']: n, labels}, version: doc.version, changed, selection: doc.selection};
  }

  function buildNullApi() {
    const none = () => { throw new CommandError('not_found', 'No document is open'); };
    return Object.freeze({get: () => undefined, set: none, delete: none, splice: none, apply: none, setMeta: none});
  }

  return session;
}
