// Routes a bridge method to the window that has the document live, or to the headless host
// (docs/architecture.md section 15.4, docs/bridge-protocol.md). Electron-agnostic: main.cjs
// attaches windows as {id, send(message)} and feeds verified IPC replies and notifications in;
// the contract tests attach fake windows the same way.

const MAIN_METHODS = new Set(['app.describe', 'documents.list', 'documents.create', 'documents.open', 'documents.delete', 'ui.capture']);
const DOC_METHODS = new Set(['engine.execute', 'engine.batch', 'document.inspect', 'document.read', 'document.find', 'document.anchor',
  'selection.get', 'selection.set', 'documents.close']);
const UI_METHODS = new Set(['document.render', 'ui.inspect', 'ui.tab', 'ui.activate', 'ui.menu', 'ui.contextMenu', 'ui.dialog.open', 'ui.dialog.get', 'ui.dialog.set',
  'ui.dialog.submit', 'ui.dialog.cancel', 'ui.pane', 'ui.key', 'ui.keys', 'ui.pointer', 'ui.type']);
const ALL_METHODS = Object.freeze([...MAIN_METHODS, 'engine.commands', ...DOC_METHODS, ...UI_METHODS].sort());
const BRIDGE_EVENTS = new Set(['doc.changed', 'doc.saved', 'selection.changed', 'document.opened', 'document.closed', 'dialog.opened', 'dialog.closed']);
const KINDS = new Set(['quill', 'grid', 'prism', 'folio', 'slate']);
const DOC_ID = /^[a-zA-Z0-9_-]{1,80}$/;
const CODES = new Set(['invalid_params', 'invalid_address', 'not_found', 'conflict', 'disabled', 'unavailable', 'approval_required',
  'approval_invalid', 'failed', 'too_large', 'timeout']);

function rpcError(code, message, data) {
  const error = new Error(message);
  error.code = CODES.has(code) ? code : 'failed';
  if (data !== undefined) error.data = data;
  return error;
}
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {{headless: {call(method: string, params: object): Promise<any>, release(id: string): Promise<any>, subscribe(fn: Function): Function,
 *   fileInfo(id: string): Promise<any>, storeChanged?(file: any): Promise<any>, storeRemoved?(id: string): Promise<any>},
 *   openDocument?: (doc: string, opts: {show: boolean, windowId?: string|number}) => Promise<{window: string|number, shown: boolean}>,
 *   capture?: (windowId: string|number, params: object) => Promise<any>,
 *   testHooks?: Record<string, (params: object) => any>,
 *   confirm?: (request: {summary: string, reason: string, risk: string, command: string, doc?: string|null}) => Promise<boolean|null>,
 *   grantPaths?: (paths: string[]) => void,
 *   timeoutMs?: number, claimTimeoutMs?: number, helloGraceMs?: number}} opts
 *   testHooks: `test.*` methods main adds only with ARKEMIS_STUDIO_TEST=1 (scripted system dialogs,
 *   closing a window, quitting); never present in production.
 *   confirm: how the person approves a destructive or irreversible request (security audit M3). Main shows a native dialog and answers
 *   true or false; the router then resends the request itself with the nonce it was given, so the caller never holds a nonce it could
 *   replay. `null` (test mode with nothing scripted) leaves the two-step protocol: the nonce goes to the caller. Without `confirm`
 *   (contract tests) that two-step protocol is all there is. It also asks before documents.open reads a file the person did not choose.
 *   grantPaths: told the absolute paths in a request once the person approved it (natively, or with the nonce main handed out in test
 *   mode), so the window that runs the approved command may write or open exactly those files (main confines window file IO to
 *   dialog-chosen paths).
 */
function createRpcRouter({headless, openDocument, capture, testHooks, confirm, grantPaths, timeoutMs = 30_000, claimTimeoutMs = 15_000, helloGraceMs = 5_000} = {}) {
  if (!headless || typeof headless.call !== 'function') throw new TypeError('createRpcRouter needs the headless host');
  const windows = new Map();
  const pending = new Map();
  const listeners = new Set();
  const approvals = new Map();       // nonce -> {summary, risk, expires}
  const claimWaiters = new Set();
  let seq = 0;
  let order = 0;

  function emit(event) {
    for (const l of [...listeners]) { try { l(event); } catch { /* a listener never breaks routing */ } }
  }
  const offHeadless = headless.subscribe(emit);

  function owner(doc) {
    if (typeof doc !== 'string') return null;
    for (const w of windows.values()) if (w.hello && w.docs.has(doc)) return w;
    return null;
  }
  function activeWindow() {
    let best = null;
    for (const w of windows.values()) {
      if (!w.hello) continue;
      if (w.active && (!best || !best.active || w.focusOrder > best.focusOrder)) best = w;
      else if (!best) best = w;
    }
    return best;
  }

  function send(w, method, params) {
    const id = 'r' + (++seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(rpcError('timeout', `The window did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`, {method}));
      }, timeoutMs);
      pending.set(id, {windowId: w.id, resolve, reject, timer, method});
      try {
        w.send({id, method, params, origin: 'bridge'});
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(rpcError('unavailable', 'The window could not be reached', {method, reason: e instanceof Error ? e.message : String(e)}));
      }
    });
  }
  function notify(w, method, params) {
    try { w.send({id: null, method, params, origin: 'bridge'}); } catch { /* best effort */ }
  }

  function waitClaim(doc, windowId) {
    if (owner(doc)) return Promise.resolve(true);
    return new Promise(resolve => {
      const started = Date.now();
      const waiter = {
        check() {
          const w = windows.get(windowId);
          if (!w) return finish(false);
          if (w.hello && w.docs.has(doc)) return finish(true);
          // A window that never says hello runs a legacy editor: do not wait the whole timeout.
          if (!w.hello && Date.now() - Math.max(started, w.attachedAt) > helloGraceMs) return finish(false);
          return undefined;
        },
      };
      const timer = setTimeout(() => finish(false), claimTimeoutMs);
      const poll = setInterval(() => waiter.check(), 250);
      function finish(value) {
        clearTimeout(timer); clearInterval(poll); claimWaiters.delete(waiter); resolve(value);
      }
      claimWaiters.add(waiter);
      waiter.check();
    });
  }

  async function openDoc(params) {
    if (!isObject(params)) throw rpcError('invalid_params', 'params must be an object', {path: '/params'});
    const byPath = params.path !== undefined;
    if (byPath && (typeof params.path !== 'string' || !params.path)) throw rpcError('invalid_params', 'path must be an absolute file path', {path: '/path'});
    if (!byPath && (typeof params.doc !== 'string' || !DOC_ID.test(params.doc))) {
      throw rpcError('invalid_params', 'doc must be a document id (or pass path to open a file)', {path: '/doc'});
    }
    if (byPath && params.doc !== undefined) throw rpcError('invalid_params', 'pass doc or path, not both', {path: '/path'});
    if (params.show !== undefined && typeof params.show !== 'boolean') throw rpcError('invalid_params', 'show must be true or false', {path: '/show'});
    if (params.headless !== undefined && typeof params.headless !== 'boolean') throw rpcError('invalid_params', 'headless must be true or false', {path: '/headless'});
    for (const k of Object.keys(params)) if (!['doc', 'path', 'show', 'headless'].includes(k)) throw rpcError('invalid_params', `${k} is not a known parameter`, {path: '/' + k});
    // Opening a path reads a file into a document the caller can then read back: a file the person did not choose (not open, not
    // recent, not picked in a dialog) needs the person's say-so, as other risky bridge calls do.
    if (byPath && typeof confirm === 'function' && !headless.files?.isKnownPath?.(params.path)) {
      const allowed = await confirm({summary: `Open ${params.path}`, reason: 'An app wants to read this file into a document it can then read back.', risk: 'destructive', command: 'documents.open', doc: null});
      if (allowed === false) throw rpcError('approval_invalid', 'The person did not allow opening that file');
    }
    if (typeof openDocument !== 'function' || params.headless === true) {
      if (byPath || params.headless === true) {
        const target = byPath ? await headless.resolveOpen({path: params.path}) : {doc: params.doc};
        if (owner(target.doc)) return {doc: target.doc, owner: 'window', window: owner(target.doc).id, alreadyOpen: true, live: true};
        const r = await headless.call('documents.open', {doc: target.doc});
        return byPath ? {...r, alreadyOpen: !!target.alreadyOpen} : r;
      }
      return headless.call('documents.open', params);
    }
    const target = byPath ? await headless.resolveOpen({path: params.path}) : {doc: params.doc, alreadyOpen: false};
    const doc = target.doc;
    const info = await headless.fileInfo(doc);
    const show = params.show !== false;
    const existing = owner(doc);
    const opened = await openDocument(doc, {show, windowId: existing ? existing.id : undefined, kind: info.kind});
    const w = windows.get(opened.window);
    if (w) w.shown = !!opened.shown;
    const live = await waitClaim(doc, opened.window);
    const lw = owner(doc);
    const b = headless.files ? headless.files.binding(doc) : null;
    return {doc, kind: info.kind, title: info.title, window: opened.window, shown: !!opened.shown, live,
      ...(lw ? {version: lw.docs.get(doc).version} : {}),
      ...(b ? {path: b.path, name: b.name, alreadyOpen: !!target.alreadyOpen || !!existing} : {})};
  }

  async function dispatch(method, params) {
    if (typeof method !== 'string' || !method) throw rpcError('invalid_params', 'method is required', {path: '/method'});
    if (params === undefined || params === null) params = {};
    if (!isObject(params)) throw rpcError('invalid_params', 'params must be an object', {path: '/params'});
    if (method === 'app.describe') {
      const base = await headless.call(method, params);
      const docs = [...base.documents];
      for (const w of windows.values()) for (const d of w.docs.values()) docs.push({...d, owner: 'window', window: w.id});
      return {...base, methods: testHooks ? [...ALL_METHODS, ...Object.keys(testHooks)].sort() : ALL_METHODS, documents: docs, windows: describeWindows()};
    }
    if (testHooks && Object.hasOwn(testHooks, method)) return testHooks[method](params);
    if (method === 'documents.list') {
      const r = await headless.call(method, params);
      return {...r, documents: r.documents.map(d => {
        const w = owner(d.id);
        if (!w) return d;
        const live = w.docs.get(d.id);
        return {...d, open: true, owner: 'window', window: w.id, version: live.version, dirty: !!live.dirty};
      })};
    }
    if (method === 'documents.open') return openDoc(params);
    if (method === 'documents.delete') {
      if (owner(params.doc)) throw rpcError('conflict', 'The document is open in a window: close it first (documents.close)', {doc: params.doc});
      return headless.call(method, params);
    }
    if (method === 'ui.capture') {
      // `window` (an id from documents.open or app.describe) captures that window, live or not.
      const w = params.window !== undefined ? windows.get(params.window) ?? null
        : typeof params.doc === 'string' ? owner(params.doc) : activeWindow() || [...windows.values()][0];
      if (!w) throw rpcError('unavailable', 'No window is open', {hint: 'documents.open'});
      if (typeof capture !== 'function') throw rpcError('unavailable', 'Window capture is not available here');
      return capture(w.id, params);
    }
    if (method === 'documents.create') return headless.call(method, params);
    if (method === 'engine.commands' || DOC_METHODS.has(method)) {
      const w = owner(params.doc);
      if (w && (method !== 'engine.commands' || w.methods.has(method))) return send(w, method, params);
      return headless.call(method, params);
    }
    if (UI_METHODS.has(method)) {
      const w = typeof params.doc === 'string' ? owner(params.doc) : activeWindow();
      if (!w) throw rpcError('unavailable', `${method} needs the document open in a window`, {hint: 'documents.open'});
      return send(w, method, params);
    }
    throw rpcError('not_found', `Unknown method ${method}`, {method});
  }

  function remember(error, params) {
    if (error?.code !== 'approval_required' || !isObject(error.data) || typeof error.data.nonce !== 'string') return;
    const now = Date.now();
    for (const [n, a] of approvals) if (a.expires <= now) approvals.delete(n);
    if (approvals.size > 1000) approvals.delete(approvals.keys().next().value);
    approvals.set(error.data.nonce, {summary: String(error.data.summary ?? ''), risk: error.data.risk, doc: params?.doc, expires: now + 5 * 60_000});
  }
  function toast(params) {
    const nonce = params?.approval?.nonce;
    if (typeof nonce !== 'string' || !approvals.has(nonce)) return;
    const a = approvals.get(nonce);
    approvals.delete(nonce);
    const text = 'Automation: ' + a.summary;
    const w = owner(a.doc);
    if (w) notify(w, 'ui.toast', {text, risk: a.risk});
    else for (const x of windows.values()) if (x.hello && x.methods.has('ui.toast')) notify(x, 'ui.toast', {text, risk: a.risk});
  }

  /** Absolute path strings under a `path` key anywhere in the params (a command's, or a batch step's). */
  function pathsIn(value, depth = 0, out = []) {
    if (depth > 6 || out.length > 50 || !value || typeof value !== 'object') return out;
    if (Array.isArray(value)) { for (const v of value.slice(0, 200)) pathsIn(v, depth + 1, out); return out; }
    for (const [k, v] of Object.entries(value)) {
      if (k === 'path' && typeof v === 'string' && v) out.push(v);
      else pathsIn(v, depth + 1, out);
    }
    return out;
  }
  const grant = params => { if (typeof grantPaths === 'function') { const paths = pathsIn(params); if (paths.length) grantPaths(paths); } };
  const handedOut = new Set();       // nonces given to a caller in test mode (confirm answered null)

  /** dispatch, with the person's native approval standing in for the nonce round trip when main supplies `confirm`. */
  async function dispatchApproved(method, params) {
    if (isObject(params) && isObject(params.approval) && handedOut.delete(params.approval.nonce)) grant(params);
    try { return await dispatch(method, params); } catch (e) {
      if (typeof confirm !== 'function' || e?.code !== 'approval_required' || !isObject(e.data) || typeof e.data.nonce !== 'string' || !isObject(params)) throw e;
      const allowed = await confirm({summary: String(e.data.summary ?? ''), reason: String(e.data.reason ?? ''), risk: String(e.data.risk ?? ''),
        command: typeof params.command === 'string' ? params.command : method, doc: typeof params.doc === 'string' ? params.doc : null});
      if (allowed === null) { if (handedOut.size > 1000) handedOut.clear(); handedOut.add(e.data.nonce); throw e; }
      if (allowed !== true) throw rpcError('approval_invalid', "The person did not allow this");
      grant(params);
      return dispatch(method, {...params, approval: {nonce: e.data.nonce}});
    }
  }

  async function call(method, params) {
    try {
      const result = await dispatchApproved(method, params);
      toast(params);
      return result;
    } catch (e) {
      const error = e && typeof e === 'object' && typeof e.code === 'string' && CODES.has(e.code)
        ? e : rpcError('failed', e instanceof Error ? e.message : String(e));
      remember(error, params);
      throw error;
    }
  }

  function describeWindows() {
    return [...windows.values()].map(w => ({window: w.id, shown: !!w.shown, live: !!w.hello, active: w.active,
      documents: [...w.docs.keys()]}));
  }

  function liveDocs(list) {
    const out = new Map();
    if (!Array.isArray(list)) return out;
    for (const d of list.slice(0, 500)) {
      if (!isObject(d) || typeof d.doc !== 'string' || !DOC_ID.test(d.doc)) continue;
      out.set(d.doc, {doc: d.doc, kind: KINDS.has(d.kind) ? d.kind : null, title: typeof d.title === 'string' ? d.title.slice(0, 240) : '',
        version: Number.isSafeInteger(d.version) ? d.version : 0, dirty: d.dirty === true,
        storeRevision: Number.isSafeInteger(d.storeRevision) ? d.storeRevision : null});
    }
    return out;
  }

  return Object.freeze({
    methods: ALL_METHODS,
    call,
    owner: doc => owner(doc)?.id ?? null,
    describeWindows,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },

    attachWindow({id, send: sender, shown = false}) {
      if (typeof sender !== 'function') throw new TypeError('attachWindow needs send()');
      windows.set(id, {id, send: sender, shown, hello: false, methods: new Set(), docs: new Map(), active: null, focusOrder: 0,
        attachedAt: Date.now()});
    },
    setShown(id, shown) { const w = windows.get(id); if (w) w.shown = !!shown; },
    detachWindow(id) {
      const w = windows.get(id);
      if (!w) return;
      windows.delete(id);
      for (const [rid, p] of pending) {
        if (p.windowId !== id) continue;
        clearTimeout(p.timer); pending.delete(rid);
        p.reject(rpcError('unavailable', 'The window closed before it answered', {method: p.method}));
      }
      for (const d of w.docs.values()) emit({type: 'document.closed', doc: d.doc, version: d.version, owner: 'window', window: id});
      for (const waiter of claimWaiters) waiter.check();
    },
    /** A reply from window `windowId` (already sender-verified by main). Returns false when dropped. */
    onReply(windowId, message) {
      if (!isObject(message) || typeof message.id !== 'string') return false;
      const p = pending.get(message.id);
      if (!p || p.windowId !== windowId) return false;
      clearTimeout(p.timer);
      pending.delete(message.id);
      if (message.ok === true) p.resolve(message.result === undefined ? null : message.result);
      else {
        const err = isObject(message.error) ? message.error : {};
        p.reject(rpcError(typeof err.code === 'string' ? err.code : 'failed', typeof err.message === 'string' ? err.message : 'The window could not run the request',
          err.data));
      }
      return true;
    },
    /** A notification from window `windowId` (already sender-verified by main). */
    onNotify(windowId, message) {
      const w = windows.get(windowId);
      if (!w || !isObject(message)) return false;
      if (message.type === 'hello') {
        w.hello = true;
        w.methods = new Set(Array.isArray(message.methods) ? message.methods.filter(m => typeof m === 'string').slice(0, 200) : []);
      } else if (message.type === 'documents') {
        const before = w.docs;
        w.docs = liveDocs(message.docs);
        w.active = typeof message.active === 'string' && w.docs.has(message.active) ? message.active : null;
        if (w.active) w.focusOrder = ++order;
        for (const id of w.docs.keys()) if (!before.has(id)) headless.release(id).catch(() => {});
      } else if (message.type === 'event') {
        const event = message.event;
        if (!isObject(event) || !BRIDGE_EVENTS.has(event.type)) return false;
        if (typeof event.doc === 'string' && w.docs.has(event.doc) && Number.isSafeInteger(event.version)) {
          w.docs.get(event.doc).version = event.version;
        }
        emit({...event, owner: 'window', window: windowId});
      } else if (message.type === 'bye') {
        w.hello = false;
        w.docs = new Map();
        w.active = null;
      } else return false;
      for (const waiter of claimWaiters) waiter.check();
      return true;
    },
    storeChanged(file) { return headless.storeChanged ? headless.storeChanged(file).catch(() => false) : Promise.resolve(false); },
    storeRemoved(id) { return headless.storeRemoved ? headless.storeRemoved(id).catch(() => false) : Promise.resolve(false); },
    close() {
      offHeadless?.();
      for (const [rid, p] of pending) { clearTimeout(p.timer); pending.delete(rid); p.reject(rpcError('unavailable', 'The app is closing')); }
    },
  });
}

module.exports = {createRpcRouter, rpcError, ALL_METHODS, BRIDGE_EVENTS: [...BRIDGE_EVENTS]};
