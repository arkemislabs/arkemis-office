// Security audit M2 (paths a window or the bridge names), M3 (approval is the person's, in a native dialog) and L5
// (a bridge file.open of a path the person did not choose needs approval).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createTestSession} from '../../core/kernel/testing.mjs';
import {createTestHost, createMemoryFiles} from '../../core/kernel/host.mjs';
import fileFamily from '../../core/common/commands/file.mjs';

const require = createRequire(import.meta.url);
const {createStore, createFiles} = require('../../electron/store.cjs');
const {createRpcRouter} = require('../../electron/rpc-router.cjs');
const {assertLocalFilePath} = require('../../electron/safe-path.cjs');

const B = String.fromCharCode(92);

async function service() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-ipc-'));
  const store = await createStore(path.join(base, 'documents'));
  const files = await createFiles({store, root: base, product: 'quill', worker: async () => ({})});
  return {base, store, files, done: () => fs.rm(base, {recursive: true, force: true})};
}

test('M2: UNC, device and stream paths are refused by open and write', async () => {
  const {files, done} = await service();
  try {
    const bad = [`${B}${B}attacker${B}share${B}x.txt`, '//attacker/share/x.txt', `${B}${B}?${B}C:${B}x.docx`, `${B}${B}.${B}pipe${B}x`, 'C:/Users/a/x.docx:stream', 'C:/Users/NUL.docx', 'relative.docx'];
    for (const p of bad) {
      await assert.rejects(files.open(p), e => e.code === 'invalid_params', p);
      await assert.rejects(files.write('d', {id: 'd'}, {path: p, format: 'docx'}), e => e.code === 'invalid_params', p);
    }
    // A drive path is a local absolute path on Windows only (on macOS and Linux 'C:/...' is relative and refused).
    if (process.platform === 'win32') assert.doesNotThrow(() => assertLocalFilePath('C:/Users/me/Report.docx'));
    else assert.throws(() => assertLocalFilePath('C:/Users/me/Report.docx'));
    assert.doesNotThrow(() => assertLocalFilePath('/home/me/report.docx'));
  } finally { await done(); }
});

test('M2: rename takes a plain name, never a separator or ..', async () => {
  const {base, files, done} = await service();
  try {
    const made = await files.create('quill', {});
    const target = path.join(base, 'Report.docx');
    await fs.writeFile(target, 'x');
    await files.write(made.doc, made.file, {path: target, format: 'docx', bind: true});
    for (const name of [`..${B}..${B}evil`, '../evil', 'sub/dir', `a${B}b`, '..', '.', 'C:evil', 'NUL', 'x'.repeat(201), 'trailing.', '']) {
      await assert.rejects(files.rename(made.doc, name), e => e.code === 'invalid_params', JSON.stringify(name));
    }
    assert.equal((await fs.readFile(target, 'utf8')), 'x', 'the file did not move');
    const b = await files.rename(made.doc, 'Renamed');
    assert.equal(path.dirname(b.path), base);
    assert.equal(path.basename(b.path), 'Renamed.docx');
  } finally { await done(); }
});

test('M2/L5: a path is known only when chosen in a dialog, open, or recent', async () => {
  const {base, files, done} = await service();
  try {
    const p = path.join(base, 'Chosen.docx');
    assert.equal(files.isKnownPath(p), false);
    files.trust(p);
    assert.equal(files.isKnownPath(p), true);
    assert.equal(files.isKnownPath(path.join(base, 'Other.docx')), false);
  } finally { await done(); }
});

function stubHeadless({known = () => false} = {}) {
  const calls = [];
  return {
    calls,
    files: {isKnownPath: known, binding: () => null},
    subscribe: () => () => {},
    release: async () => ({}),
    fileInfo: async () => ({kind: 'quill', title: 'T'}),
    resolveOpen: async p => { calls.push(['resolveOpen', p]); return {doc: 'd1', alreadyOpen: false}; },
    async call(method, params) {
      calls.push([method, params]);
      if (method === 'documents.delete') {
        if (!params.approval) throw Object.assign(new Error('needs approval'), {code: 'approval_required', data: {nonce: 'n-1', summary: 'Move "T" to the trash', reason: 'This loses data outside the undo history.', risk: 'destructive'}});
        if (params.approval.nonce !== 'n-1') throw Object.assign(new Error('bad nonce'), {code: 'approval_invalid'});
        return {deleted: true};
      }
      return {ok: true, method};
    },
  };
}

test('M3: the person approves in a native dialog; the caller never receives the nonce', async () => {
  const asked = [];
  const headless = stubHeadless();
  const router = createRpcRouter({headless, confirm: async req => { asked.push(req); return true; }});
  const result = await router.call('documents.delete', {doc: 'd1'});
  assert.deepEqual(result, {deleted: true});
  assert.equal(asked.length, 1);
  assert.equal(asked[0].summary, 'Move "T" to the trash');
  // The person said no: nothing was deleted and the caller got no nonce to replay.
  const denied = createRpcRouter({headless: stubHeadless(), confirm: async () => false});
  await assert.rejects(denied.call('documents.delete', {doc: 'd1'}), e => e.code === 'approval_invalid' && !JSON.stringify(e.data ?? {}).includes('n-1'));
});

test('M3: with nothing scripted (test mode) the two-step protocol stays; without confirm too', async () => {
  for (const options of [{confirm: async () => null}, {}]) {
    const router = createRpcRouter({headless: stubHeadless(), ...options});
    await assert.rejects(router.call('documents.delete', {doc: 'd1'}), e => e.code === 'approval_required' && e.data.nonce === 'n-1');
    assert.deepEqual(await router.call('documents.delete', {doc: 'd1', approval: {nonce: 'n-1'}}), {deleted: true});
  }
});

test('L5: documents.open of a path the person did not choose asks first', async () => {
  const asked = [];
  const headless = stubHeadless({known: p => p === 'C:/Docs/Mine.docx'});
  const router = createRpcRouter({headless, confirm: async req => { asked.push(req); return false; }});
  await assert.rejects(router.call('documents.open', {path: 'C:/Users/me/.ssh/notes.txt'}), e => e.code === 'approval_invalid');
  assert.equal(asked.length, 1);
  assert.match(asked[0].summary, /notes\.txt/);
  assert.equal(headless.calls.some(c => c[0] === 'resolveOpen'), false, 'the file was not read');
  await router.call('documents.open', {path: 'C:/Docs/Mine.docx'});
  assert.equal(headless.calls.filter(c => c[0] === 'resolveOpen').length, 1);
  assert.equal(asked.length, 1, 'a known path needs no question');
});

test('L5: file.open over the bridge asks approval for an unknown path, not for a known one', async () => {
  const files = createMemoryFiles({disk: {'C:\\Docs\\Plan.docx': {format: 'docx', file: {kind: 'quill'}}}});
  files.known = p => p === 'C:\\Docs\\Plan.docx';
  const t = await createTestSession('quill', {host: createTestHost({files}), modules: [fileFamily], sources: ['core/common/commands/file.mjs'], foundation: {}});
  files.bind(t.docId, {kind: 'quill', name: 'Document1'});
  await assert.rejects(t.bridge('file.open', {path: 'C:\\Users\\me\\secret.docx'}), e => e.code === 'approval_required' && /secret\.docx/.test(e.message));
  const r = await t.bridge('file.open', {path: 'C:\\Docs\\Plan.docx'});
  assert.equal(r.result.opened, true);
});

test('M2/M3: the paths of an approved request are granted to the window, and only after approval', async () => {
  const granted = [];
  const headless = stubHeadless();
  const approvedCall = {doc: 'd1', command: 'file.saveCopy', params: {path: 'C:/out/copy.xlsx'}};
  // Native approval granted: the window may write exactly that path.
  const yes = createRpcRouter({headless, confirm: async () => true, grantPaths: p => granted.push(...p)});
  await yes.call('documents.delete', approvedCall);
  assert.deepEqual(granted, ['C:/out/copy.xlsx']);
  // Denied: nothing is granted.
  granted.length = 0;
  const no = createRpcRouter({headless: stubHeadless(), confirm: async () => false, grantPaths: p => granted.push(...p)});
  await assert.rejects(no.call('documents.delete', approvedCall));
  assert.deepEqual(granted, []);
  // A caller that invents a nonce gets no grant (test-mode nonces count only when main handed them out).
  const test = createRpcRouter({headless: stubHeadless(), confirm: async () => null, grantPaths: p => granted.push(...p)});
  await assert.rejects(test.call('documents.delete', {...approvedCall, approval: {nonce: 'made-up'}}));
  assert.deepEqual(granted, []);
  await assert.rejects(test.call('documents.delete', approvedCall), e => e.code === 'approval_required');
  await test.call('documents.delete', {...approvedCall, approval: {nonce: 'n-1'}});
  assert.deepEqual(granted, ['C:/out/copy.xlsx']);
});
