// /v2/rpc contract: auth, every main and headless method's happy path, errors, approvals, conflicts and batches.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startTestBridge, rawRequest} from './helpers.mjs';

test('auth, origin and host checks guard /v2', async () => {
  const t = await startTestBridge();
  try {
    const body = JSON.stringify({id: 1, method: 'app.describe'});
    const port = t.bridge.port;
    const headers = {'Content-Type': 'application/json', Host: `127.0.0.1:${port}`};
    assert.equal((await rawRequest(port, {method: 'POST', path: '/v2/rpc', headers, body})).status, 401);
    assert.equal((await rawRequest(port, {method: 'POST', path: '/v2/rpc', headers: {...headers, Authorization: 'Bearer ' + 'b'.repeat(64)}, body})).status, 401);
    assert.equal((await rawRequest(port, {method: 'POST', path: '/v2/rpc', headers: {...headers, ...t.auth, Origin: 'https://evil.example'}, body})).status, 403);
    assert.equal((await rawRequest(port, {method: 'POST', path: '/v2/rpc', headers: {...headers, ...t.auth, Host: 'evil.example'}, body})).status, 403);
    assert.equal((await rawRequest(port, {method: 'GET', path: '/v2/events', headers: {Host: `127.0.0.1:${port}`}})).status, 401);
    assert.equal((await rawRequest(port, {method: 'POST', path: '/v2/rpc', headers: {...headers, ...t.auth, Origin: 'null'}, body})).status, 403);
    assert.equal((await rawRequest(port, {method: 'POST', path: '/v2/mcp', headers: {...headers, ...t.auth}, body: '{}'})).status, 404);
    const ok = await rawRequest(port, {method: 'POST', path: '/v2/rpc', headers: {...headers, ...t.auth}, body});
    assert.equal(ok.status, 200);
    assert.equal((await rawRequest(port, {method: 'GET', path: '/v2/nothing', headers: {...headers, ...t.auth}})).status, 404);
  } finally { await t.close(); }
});

test('app.describe, documents.create/list and engine.commands', async () => {
  const t = await startTestBridge();
  try {
    const describe = await t.rpc('app.describe', {});
    assert.equal(describe.product, 'studio');
    assert.equal(describe.protocol, 2);
    assert.deepEqual(describe.apps, ['quill', 'grid', 'prism', 'folio', 'slate']);
    assert.ok(describe.methods.includes('engine.execute'));
    assert.equal(describe.limits.bodyBytes, 16 * 1024 * 1024);
    const {doc, storeRevision} = await t.rpc('documents.create', {kind: 'grid', title: 'Budget'});
    assert.equal(storeRevision, 1);
    const {documents} = await t.rpc('documents.list', {kind: 'grid'});
    assert.deepEqual(documents.map(d => [d.id, d.kind, d.title, d.open]), [[doc, 'grid', 'Budget', false]]);
    assert.deepEqual((await t.rpc('documents.list', {kind: 'quill'})).documents, []);
    const cmds = await t.rpc('engine.commands', {doc, search: 'rename'});
    const rename = cmds.commands.find(c => c.id === 'file.rename');
    assert.equal(rename.risk, 'edit');
    assert.equal(rename.params.type, 'object');
    assert.deepEqual(rename.params.required, ['name']);
    assert.equal(rename.enabled, true);
    const caret = (await t.rpc('engine.commands', {doc, search: 'caret'})).commands[0];
    assert.equal(caret.enabled, false);
    assert.match(caret.disabledReason, /window/);
    const all = await t.rpc('engine.commands', {search: 'undo'});
    assert.ok(all.commands.some(c => c.app === 'quill' && c.id === 'edit.undo'));
    const grid = await t.rpc('documents.list', {});
    assert.equal(grid.documents.find(d => d.id === doc).open, true);
  } finally { await t.close(); }
});

test('engine.execute edits headless, persists with a revision check and lands on the undo stack', async () => {
  const t = await startTestBridge();
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'quill', title: 'Draft'});
    const run = await t.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'Final'}, baseVersion: 0});
    assert.equal(run.version, 1);
    assert.equal(run.undoLabel, 'Automation: Rename Document');
    assert.deepEqual(run.result, {name: 'Final'});
    const stored = await t.store.get(doc);
    assert.equal(stored.title, 'Final');
    assert.equal(stored.revision, 2);
    const dry = await t.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'Maybe'}, dryRun: true});
    assert.equal(dry.dryRun, true);
    assert.equal((await t.store.get(doc)).title, 'Final');
    const undone = await t.rpc('engine.execute', {doc, command: 'edit.undo', params: {}});
    assert.equal(undone.result.undone, 1);
    assert.equal((await t.store.get(doc)).title, 'Draft');
    await t.rpc('engine.execute', {doc, command: 'edit.redo'});
    assert.equal((await t.store.get(doc)).title, 'Final');
    const read = await t.rpc('engine.execute', {doc, command: 'bridgetest.title'});
    assert.deepEqual(read.result, {title: 'Final'});
  } finally { await t.close(); }
});

test('errors carry codes, HTTP statuses and specifics', async () => {
  const t = await startTestBridge();
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'prism'});
    let r = await t.raw('engine.execute', {doc, command: 'file.rename', params: {name: 7}});
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'invalid_params');
    assert.equal(r.body.error.data.path, '/name');
    r = await t.raw('engine.execute', {doc, command: 'nope.nothing'});
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'not_found');
    r = await t.raw('no.such.method', {});
    assert.equal(r.status, 404);
    r = await t.raw('engine.execute', {doc: 'missing_doc', command: 'file.rename', params: {name: 'x'}});
    assert.equal(r.body.error.code, 'not_found');
    r = await t.raw('engine.execute', {doc: '../escape', command: 'file.rename', params: {name: 'x'}});
    assert.equal(r.body.error.code, 'invalid_params');
    await t.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'One'}});
    r = await t.raw('engine.execute', {doc, command: 'file.rename', params: {name: 'Two'}, baseVersion: 0});
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'conflict');
    assert.equal(r.body.error.data.version, 1);
    r = await t.raw('engine.execute', {doc, command: 'bridgetest.caret'});
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'unavailable');
    assert.equal(r.body.error.data.hint, 'documents.open');
    for (const method of ['ui.inspect', 'document.render', 'ui.dialog.open']) {
      r = await t.raw(method, {doc});
      assert.equal(r.body.error.code, 'unavailable', method);
      assert.equal(r.body.error.data.hint, 'documents.open', method);
    }
    r = await t.raw('engine.execute', {doc, command: 'bridgetest.fail'});
    assert.equal(r.status, 500);
    assert.equal(r.body.error.message, 'deliberate failure');
    assert.equal((await t.store.get(doc)).title, 'One');
    r = await t.post('/v2/rpc', '{not json');
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'invalid_params');
    r = await t.post('/v2/rpc', {id: 'x', method: 'app.describe', params: [1]});
    assert.equal(r.body.error.code, 'invalid_params');
    assert.equal(r.body.id, 'x');
  } finally { await t.close(); }
});

test('approval_required, resend with the nonce, replay and mismatch are rejected', async () => {
  const t = await startTestBridge();
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'quill', title: 'Keep me'});
    let r = await t.raw('engine.execute', {doc, command: 'bridgetest.wipe', params: {title: 'Gone'}});
    assert.equal(r.status, 428);
    const ask = r.body.error.data;
    assert.equal(r.body.error.code, 'approval_required');
    assert.equal(ask.summary, 'Replace the title of "Keep me" with "Gone"');
    assert.equal(ask.risk, 'destructive');
    assert.equal(ask.command, 'bridgetest.wipe');
    assert.match(ask.nonce, /^[0-9a-f]{32}$/);
    assert.ok(Date.parse(ask.expires) > Date.now());
    assert.equal((await t.store.get(doc)).title, 'Keep me');
    // Different params under the same nonce: refused, and the nonce is burned.
    r = await t.raw('engine.execute', {doc, command: 'bridgetest.wipe', params: {title: 'Other'}, approval: {nonce: ask.nonce}});
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'approval_invalid');
    r = await t.raw('engine.execute', {doc, command: 'bridgetest.wipe', params: {title: 'Gone'}});
    const nonce = r.body.error.data.nonce;
    const done = await t.rpc('engine.execute', {doc, command: 'bridgetest.wipe', params: {title: 'Gone'}, approval: {nonce}});
    assert.equal(done.undoLabel, 'Automation: Wipe Title');
    assert.equal((await t.store.get(doc)).title, 'Gone');
    r = await t.raw('engine.execute', {doc, command: 'bridgetest.wipe', params: {title: 'Gone'}, approval: {nonce}});
    assert.equal(r.body.error.code, 'approval_invalid');
    // A nonce is bound to the document version: an edit in between invalidates it.
    r = await t.raw('engine.execute', {doc, command: 'bridgetest.wipe', params: {title: 'Later'}});
    const stale = r.body.error.data.nonce;
    await t.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'Edited'}});
    r = await t.raw('engine.execute', {doc, command: 'bridgetest.wipe', params: {title: 'Later'}, approval: {nonce: stale}});
    assert.equal(r.body.error.code, 'approval_invalid');
    // file.save to a path is irreversible over the bridge.
    r = await t.raw('engine.execute', {doc, command: 'file.save', params: {path: 'C:/temp/out.docx'}});
    assert.equal(r.body.error.code, 'approval_required');
    assert.equal(r.body.error.data.risk, 'irreversible');
  } finally { await t.close(); }
});

test('engine.batch is one undo entry, all or nothing; rpc arrays answer in order', async () => {
  const t = await startTestBridge();
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'slate', title: 'Start'});
    let r = await t.raw('engine.batch', {doc, label: 'Two things', steps: [
      {command: 'file.rename', params: {name: 'Middle'}}, {command: 'bridgetest.fail', params: {}}]});
    assert.equal(r.body.error.code, 'failed');
    assert.equal((await t.store.get(doc)).title, 'Start');
    assert.equal((await t.rpc('app.describe', {})).documents.find(d => d.doc === doc).version, 0);
    r = await t.raw('engine.batch', {doc, steps: [{command: 'file.rename', params: {name: 3}}]});
    assert.equal(r.body.error.data.path, '/steps/0/params/name');
    const ok = await t.rpc('engine.batch', {doc, label: 'Rename twice', steps: [
      {command: 'file.rename', params: {name: 'A'}}, {command: 'file.properties', params: {subject: 'S'}}]});
    assert.equal(ok.undoLabel, 'Automation: Rename twice');
    assert.equal(ok.version, 1);
    const stored = await t.store.get(doc);
    assert.equal(stored.title, 'A');
    assert.equal(stored.properties.subject, 'S');
    await t.rpc('engine.execute', {doc, command: 'edit.undo'});
    const back = await t.store.get(doc);
    assert.equal(back.title, 'Start');
    assert.equal(back.properties, undefined);
    r = await t.post('/v2/rpc', [
      {id: 1, method: 'engine.execute', params: {doc, command: 'file.rename', params: {name: 'First'}}},
      {id: 2, method: 'engine.execute', params: {doc, command: 'bridgetest.title'}},
      {id: 3, method: 'nope'},
    ]);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.map(x => [x.id, x.ok]), [[1, true], [2, true], [3, false]]);
    assert.deepEqual(r.body[1].result.result, {title: 'First'});
    assert.equal((await t.post('/v2/rpc', [])).status, 400);
    assert.equal((await t.post('/v2/rpc', Array.from({length: 101}, (_, i) => ({id: i, method: 'app.describe'})))).status, 413);
  } finally { await t.close(); }
});

test('document.inspect/read/find/anchor and selection over the headless host', async () => {
  const t = await startTestBridge();
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'quill', title: 'Notes'});
    const tree = await t.rpc('document.inspect', {doc, depth: 1});
    assert.equal(tree.address, '/');
    assert.ok(tree.nodes.some(n => n.address === '/doc'));
    const read = await t.rpc('document.read', {doc, address: '/doc/type'});
    assert.equal(read.value, 'doc');
    assert.equal(read.address, '/doc/type');
    let r = await t.raw('document.read', {doc, address: '/nope'});
    assert.equal(r.body.error.code, 'not_found');
    r = await t.raw('document.read', {doc, address: 'no-slash'});
    assert.equal(r.body.error.code, 'invalid_address');
    const anchor = await t.rpc('document.anchor', {doc, address: '/doc'});
    assert.match(anchor.anchor, /^@a\d+$/);
    assert.equal((await t.rpc('document.read', {doc, address: anchor.anchor})).address, '/doc');
    const found = await t.rpc('document.find', {doc, query: 'PARAGRAPH'});
    assert.ok(found.matches.length >= 1);
    assert.match(found.matches[0].address, /\/t:0-9$/);
    assert.equal((await t.rpc('document.find', {doc, query: 'PARAGRAPH', matchCase: true})).matches.length, 0);
    r = await t.raw('document.find', {doc, query: '(', regex: true});
    assert.equal(r.body.error.code, 'invalid_params');
    const sel = await t.rpc('selection.set', {doc, ranges: [{anchor: '/doc/content'}]});
    assert.deepEqual(sel.selection, {ranges: [{anchor: '/doc/content', focus: '/doc/content'}], primary: 0});
    assert.deepEqual((await t.rpc('selection.get', {doc})).selection, sel.selection);
    r = await t.raw('selection.set', {doc, ranges: [{anchor: 'bad'}]});
    assert.equal(r.body.error.data.path, '/ranges/0/anchor');
  } finally { await t.close(); }
});

test('documents.delete needs approval and moves the file to the trash; documents.close', async () => {
  const t = await startTestBridge();
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'grid', title: 'Old'});
    await t.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'Older'}});
    const closed = await t.rpc('documents.close', {doc});
    assert.equal(closed.closed, true);
    assert.equal((await t.rpc('documents.close', {doc})).closed, false);
    const r = await t.raw('documents.delete', {doc});
    assert.equal(r.status, 428);
    assert.equal(r.body.error.data.summary, 'Move "Older" to the trash');
    const done = await t.rpc('documents.delete', {doc, approval: {nonce: r.body.error.data.nonce}});
    assert.equal(done.deleted, true);
    assert.equal(await t.store.get(doc), null);
    const again = await t.raw('documents.delete', {doc, approval: {nonce: r.body.error.data.nonce}});
    assert.equal(again.body.error.code, 'not_found');
  } finally { await t.close(); }
});

test('a write from another editor reloads a clean headless document; a stale headless write is a conflict', async () => {
  const t = await startTestBridge();
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'quill', title: 'Shared'});
    await t.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'Mine'}});
    const current = await t.store.get(doc);
    const theirs = await t.store.save({...current, title: 'Theirs'});
    assert.equal(await t.router.storeChanged(theirs), true);
    assert.equal((await t.rpc('document.read', {doc, address: '/doc/type'})).value, 'doc');
    assert.equal((await t.rpc('engine.execute', {doc, command: 'bridgetest.title'})).result.title, 'Theirs');
    // Another editor saves without telling us: our next write must not overwrite it.
    const now = await t.store.get(doc);
    await t.store.save({...now, title: 'Sneaky'});
    const r = await t.raw('engine.execute', {doc, command: 'file.rename', params: {name: 'Clobber'}});
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'conflict');
    assert.equal((await t.store.get(doc)).title, 'Sneaky');
    assert.equal((await t.rpc('engine.execute', {doc, command: 'bridgetest.title'})).result.title, 'Sneaky');
  } finally { await t.close(); }
});

test('bodies over 16 MB are refused with 413', async () => {
  const t = await startTestBridge();
  try {
    const big = JSON.stringify({id: 1, method: 'app.describe', params: {pad: 'x'.repeat(16 * 1024 * 1024)}});
    const r = await fetch(t.base + '/v2/rpc', {method: 'POST', headers: {...t.auth, 'Content-Type': 'application/json'}, body: big}).catch(e => ({status: 'reset', e}));
    assert.ok(r.status === 413 || r.status === 'reset', `status ${r.status}`);
  } finally { await t.close(); }
});

test('a single-app product only edits its own kind', async () => {
  const t = await startTestBridge({product: 'grid'});
  try {
    const describe = await t.rpc('app.describe', {});
    assert.deepEqual(describe.apps, ['grid']);
    const {doc} = await t.rpc('documents.create', {});
    assert.equal((await t.store.get(doc)).kind, 'grid');
    const r = await t.raw('documents.create', {kind: 'quill'});
    assert.equal(r.body.error.code, 'unavailable');
    const {createFile} = await import('../../core/model.mjs');
    const quill = await t.store.save(createFile('quill', 'Elsewhere'));
    const e = await t.raw('engine.execute', {doc: quill.id, command: 'file.rename', params: {name: 'x'}});
    assert.equal(e.body.error.code, 'unavailable');
    assert.deepEqual((await t.rpc('documents.list', {})).documents.map(d => d.kind), ['grid']);
  } finally { await t.close(); }
});
