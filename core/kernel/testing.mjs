// Test helpers for command families (docs/architecture.md section 17.1).
//
//   import {createTestSession, expectUndoRoundTrip} from '../../core/kernel/testing.mjs';
//   const t = await createTestSession('grid', {fixture: 'two-sheets'});
//   await expectUndoRoundTrip(t, 'home.bold', {range: '/sh:s1/A1:B2'}, after => {
//     assert.equal(after.read('/sh:s1/A1', 'props').bold, true);
//   });
//
// Runs under `node --test` and in any other JS host (no Node built-ins).

import {createSession} from './session.mjs';
import {buildRegistry} from './registry.mjs';
import {createTestHost} from './host.mjs';

export class TestFailure extends Error {
  constructor(message, details) { super(message); this.name = 'AssertionError'; if (details) this.details = details; }
}

/** Structural equality for JSON-like values; keys holding undefined count as absent. */
export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every(k => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

/** First differing path between two values (for failure messages). */
export function firstDifference(a, b, path = '') {
  if (deepEqual(a, b)) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
    return {path: path || '/', expected: a, actual: b};
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const d = firstDifference(a[k], b[k], `${path}/${k}`);
    if (d) return d;
  }
  return {path: path || '/', expected: a, actual: b};
}

const preview = v => { try { const s = JSON.stringify(v); return s && s.length > 200 ? s.slice(0, 200) + '…' : s; } catch { return String(v); } };
const fail = (message, a, b) => {
  const d = firstDifference(a, b);
  throw new TestFailure(d ? `${message} (first difference at ${d.path}: expected ${preview(d.expected)}, got ${preview(d.actual)})` : message, d);
};

/** Kernel fixtures that need no app foundation. */
export const fixtures = Object.freeze({
  empty: () => ({}),
  list: () => ({items: ['a', 'b', 'c', 'd'], meta: {title: 'List'}}),
  nested: () => ({blocks: [{id: 'b1', text: 'Hello'}, {id: 'b2', text: 'World'}], styles: {normal: {size: 11}}}),
});

async function loadGenerated(app) {
  const [commands, apps] = await Promise.all([
    import(`../generated/${app}.commands.mjs`).catch(() => null),
    import('../generated/apps.mjs').catch(() => null),
  ]);
  return {modules: commands?.modules ?? [], sources: commands?.sources ?? [], foundation: apps?.apps?.[app] ?? {}};
}

/**
 * A session with one open document for tests.
 * @param {string} app
 * @param {{fixture?: string, file?: object, content?: object, modules?: object[], sources?: string[],
 *   foundation?: object, prefs?: object, host?: object, selection?: object}} [opts]
 */
export async function createTestSession(app, opts = {}) {
  const generated = opts.modules && opts.foundation ? null : await loadGenerated(app);
  const modules = opts.modules ?? generated.modules;
  const sources = opts.sources ?? (opts.modules ? [] : generated.sources);
  const foundation = opts.foundation ?? generated.foundation;
  const registry = buildRegistry(modules, {app, sources});
  const host = opts.host ?? createTestHost();
  const session = createSession({app, registry, host, foundation, prefs: opts.prefs});
  let file = opts.file ? structuredClone(opts.file) : null;
  if (!file) {
    let content = opts.content ? structuredClone(opts.content) : null;
    if (!content && opts.fixture) {
      const make = foundation.fixtures?.[opts.fixture] ?? fixtures[opts.fixture];
      if (typeof make !== 'function') throw new TestFailure(`Unknown fixture ${opts.fixture} for ${app}`);
      content = await make();
      if (content && content.content && content.id) { file = content; content = null; }
    }
    if (!file && !content) {
      const legacy = await import('../model.mjs');
      file = legacy.createFile(app, 'Test document');
      file.id = 'doc1';
    }
    if (!file) file = {id: 'doc1', schema: 2, kind: app, title: 'Test document', revision: 0, createdAt: '2026-10-29T12:00:00.000Z',
      updatedAt: '2026-10-29T12:00:00.000Z', starred: false, links: [], content};
  }
  const docId = session.open(file, {selection: opts.selection});
  const t = {
    app, session, host, registry, docId,
    get doc() { return session.get(docId); },
    get file() { return session.get(docId).file; },
    get content() { return session.get(docId).file.content; },
    get version() { return session.get(docId).version; },
    exec: (id, params = {}, o = {}) => session.execute(docId, id, params, {origin: 'test', ...o}),
    bridge: (id, params = {}, o = {}) => session.execute(docId, id, params, {...o, origin: 'bridge'}),
    batch: (steps, o = {}) => session.batch(docId, steps, {origin: 'test', ...o}),
    undo: (n = 1) => session.undo(docId, n, {origin: 'test'}),
    redo: (n = 1) => session.redo(docId, n, {origin: 'test'}),
    state: (id, params) => session.state(docId, id, params),
    read: (address, as) => session.read(docId, address, as),
    anchor: address => session.anchor(docId, address),
    where: address => session.where(docId, address),
  };
  return t;
}

function readerFor(t, file) {
  return {
    file, content: file.content,
    read: (address, as = 'json') => t.session.addressing.read(file.content, t.session.addressing.parse(address), as),
  };
}

/**
 * Asserts: the command changes the document; `check(after)` passes; undo restores deep-equal
 * content and selection; redo reproduces the run's content; versions advance by one each time.
 * Returns the command's ExecResult.
 */
export async function expectUndoRoundTrip(t, id, params = {}, check, opts = {}) {
  const doc = t.session.get(t.docId);
  const before = {file: structuredClone(doc.file), selection: structuredClone(doc.selection), version: doc.version};
  const result = await t.session.execute(t.docId, id, params, {origin: opts.origin || 'test', approval: opts.approval});
  const afterFile = structuredClone(doc.file);
  const afterSelection = structuredClone(doc.selection);
  if (deepEqual(before.file, afterFile)) throw new TestFailure(`${id} did not change the document`);
  if (doc.version !== before.version + 1) throw new TestFailure(`${id}: version is ${doc.version}, expected ${before.version + 1}`);
  if (typeof check === 'function') await check(readerFor(t, doc.file), result);
  await t.session.undo(t.docId, 1, {origin: 'test'});
  if (!deepEqual(before.file, doc.file)) fail(`undo of ${id} did not restore the document`, before.file, doc.file);
  if (!deepEqual(before.selection, doc.selection)) fail(`undo of ${id} did not restore the selection`, before.selection, doc.selection);
  if (doc.version !== before.version + 2) throw new TestFailure(`undo of ${id}: version is ${doc.version}, expected ${before.version + 2}`);
  await t.session.redo(t.docId, 1, {origin: 'test'});
  if (!deepEqual(afterFile, doc.file)) fail(`redo of ${id} did not reproduce the document`, afterFile, doc.file);
  if (!deepEqual(afterSelection, doc.selection)) fail(`redo of ${id} did not reproduce the selection`, afterSelection, doc.selection);
  if (doc.version !== before.version + 3) throw new TestFailure(`redo of ${id}: version is ${doc.version}, expected ${before.version + 3}`);
  return result;
}

/** Runs a command over the bridge path: params validation and the risk gate apply. */
export async function expectApprovalRequired(t, id, params = {}) {
  try {
    await t.bridge(id, params);
  } catch (e) {
    if (e.code === 'approval_required') return e.data;
    throw e;
  }
  throw new TestFailure(`${id} ran over the bridge without asking for approval`);
}
