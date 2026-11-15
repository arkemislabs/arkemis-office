// In-process automation layer for contract tests (docs/architecture.md section 17.4): the test-only loopback transport
// (electron/test-rpc-server.cjs) over a temporary store, the headless host and the rpc router. No Electron.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {defineCommands} from '../../core/kernel/command.mjs';
import {s} from '../../core/kernel/schema.mjs';
import {CommandError} from '../../core/kernel/errors.mjs';
import {createSession} from '../../core/kernel/session.mjs';
import {buildRegistry} from '../../core/kernel/registry.mjs';
import {createHost} from '../../core/kernel/host.mjs';
import {createRpcMethods} from '../../core/kernel/rpc-methods.mjs';
import {createHeadlessHost} from '../../electron/headless-host.mjs';

const require = createRequire(import.meta.url);
const {startTestRpcServer} = require('../../electron/test-rpc-server.cjs');
const {createStore} = require('../../electron/store.cjs');
const {createRpcRouter} = require('../../electron/rpc-router.cjs');

/** Test-only commands over file metadata (valid for every schema-1 kind). */
export const testFamily = defineCommands({
  family: 'bridgetest',
  app: '*',
  upstream: {repo: 'office', files: []},
  commands: [
    {id: 'bridgetest.wipe', label: 'Wipe Title', risk: 'destructive', params: s.object({title: s.optional(s.string({min: 1, max: 100}))}),
      summary: (ctx, p) => `Replace the title of "${ctx.file.title}" with "${p.title ?? 'Wiped'}"`,
      run(ctx, p) { ctx.change.setMeta('title', p.title ?? 'Wiped'); return {title: p.title ?? 'Wiped'}; }},
    {id: 'bridgetest.fail', label: 'Fail', risk: 'edit', params: s.object({}),
      run(ctx) { ctx.change.setMeta('title', 'should never land'); throw new CommandError('failed', 'deliberate failure'); }},
    {id: 'bridgetest.caret', label: 'Move Caret', risk: 'edit', needs: 'view', effect: 'view', undo: 'none', params: s.object({}),
      run() { return null; }},
    {id: 'bridgetest.title', label: 'Read Title', risk: 'read', params: s.object({}),
      run(ctx) { return {title: ctx.file.title}; }},
  ],
});

/** The app's generated families plus the test family; `foundation`: the app's real foundation (schema, migrate...) from core/generated/apps.mjs. */
export async function loadAppWithTestFamily(app, {foundation = false} = {}) {
  const generated = await import(`../../core/generated/${app}.commands.mjs`).catch(() => ({modules: [], sources: []}));
  const apps = foundation ? await import('../../core/generated/apps.mjs').catch(() => null) : null;
  return {modules: [...generated.modules, testFamily], sources: [...generated.sources, 'tests/bridge/helpers.mjs'], foundation: apps?.apps?.[app] ?? {}};
}

export async function tempDir(prefix = 'arkemis-bridge-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * @param {{product?: string, openDocument?: Function, capture?: Function, timeoutMs?: number, claimTimeoutMs?: number, helloGraceMs?: number,
 *   newHost?: boolean | ((kind: string) => boolean)}} [opts]
 *   newHost: the headless host edits schema 2 for those apps (documents.create makes schema 2, schema 1 is migrated on open), with the real foundations.
 */
export async function startTestBridge(opts = {}) {
  const dir = await tempDir();
  const store = await createStore(path.join(dir, 'documents'));
  const product = opts.product ?? 'studio';
  const headless = await createHeadlessHost({store, product, appVersion: '0.1.0-test', loadApp: opts.newHost ? app => loadAppWithTestFamily(app, {foundation: true}) : loadAppWithTestFamily, newHost: opts.newHost ?? false});
  const router = createRpcRouter({headless, openDocument: opts.openDocument, capture: opts.capture,
    timeoutMs: opts.timeoutMs ?? 2000, claimTimeoutMs: opts.claimTimeoutMs ?? 1500, helloGraceMs: opts.helloGraceMs ?? 300});
  const changed = [];
  const bridge = await startTestRpcServer({router});
  const base = `http://127.0.0.1:${bridge.port}`;
  const auth = {Authorization: `Bearer ${bridge.token}`};
  let seq = 0;
  const post = async (route, body, headers = {}) => {
    const response = await fetch(base + route, {method: 'POST', headers: {...auth, 'Content-Type': 'application/json', ...headers}, body: typeof body === 'string' ? body : JSON.stringify(body)});
    const text = await response.text();
    return {status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null};
  };
  const t = {
    dir, store, headless, router, bridge, base, auth, changed, product,
    post,
    /** Raw /v2/rpc call: {status, body}. */
    raw: (method, params) => post('/v2/rpc', {id: ++seq, method, params}),
    /** /v2/rpc call that returns the result or throws the error object. */
    async rpc(method, params) {
      const r = await post('/v2/rpc', {id: ++seq, method, params});
      if (!r.body.ok) throw Object.assign(new Error(r.body.error.message), r.body.error, {status: r.status});
      return r.body.result;
    },
    async close() {
      router.close();
      await bridge.stop();
      await fs.rm(dir, {recursive: true, force: true});
    },
  };
  return t;
}

/** Plain http request (lets a test set Host and Origin headers, which fetch forbids). */
export function rawRequest(port, {method = 'GET', path: route = '/', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path: route, headers}, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: data}));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Read Server-Sent Events from /v2/events until `until(events)` is true or the timeout passes. */
export async function collectEvents(t, query = '', until = () => false, timeoutMs = 3000) {
  const controller = new AbortController();
  const response = await fetch(`${t.base}/v2/events${query}`, {headers: t.auth, signal: controller.signal});
  const events = [];
  const ready = {status: response.status, events, done: null};
  ready.done = (async () => {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, {stream: true});
        let i;
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
          if (data) events.push(JSON.parse(data));
        }
        if (until(events)) break;
      }
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return events;
  })();
  return ready;
}

/**
 * A fake window: a renderer-side Session with RendererBridge's document methods, answering the
 * router the way the preload does (docs/bridge-protocol.md section 2).
 */
export async function fakeWindow(t, id, {files = [], answer = true, kind = 'quill'} = {}) {
  const loaded = await loadAppWithTestFamily(kind);
  const session = createSession({app: kind, registry: buildRegistry(loaded.modules, {app: kind, sources: loaded.sources}),
    host: createHost('renderer', {save: async file => ({revision: (file.revision ?? 0) + 1}), close: async () => {}})});
  const methods = createRpcMethods(session, {viewAvailable: true});
  const received = [];
  const w = {id, session, received, answer};
  const reply = message => setImmediate(() => t.router.onReply(id, message));
  t.router.attachWindow({id, send: request => {
    received.push(request);
    if (request.id === null || !w.answer) return;
    (async () => {
      try {
        let result;
        if (methods.has(request.method)) result = await methods.call(request.method, request.params);
        else if (request.method === 'ui.inspect') result = {doc: session.activeDocId, tab: 'home'};
        else throw new CommandError('not_found', `Unknown method ${request.method}`);
        reply({id: request.id, ok: true, result: JSON.parse(JSON.stringify(result ?? null))});
      } catch (e) {
        reply({id: request.id, ok: false, error: {code: e.code ?? 'failed', message: e.message, ...(e.data !== undefined ? {data: e.data} : {})}});
      }
    })();
  }});
  session.subscribe(event => t.router.onNotify(id, {type: 'event', event}));
  w.hello = () => t.router.onNotify(id, {type: 'hello', protocol: 2, methods: ['engine.commands', 'engine.execute', 'ui.inspect', 'ui.toast', ...methods.methods]});
  w.claim = () => t.router.onNotify(id, {type: 'documents', active: session.activeDocId,
    docs: [...session.docs.values()].map(d => ({doc: d.id, kind: d.file.kind, title: d.file.title, version: d.version, dirty: d.dirty, storeRevision: d.storeRevision}))});
  for (const file of files) session.open(file);
  return w;
}
