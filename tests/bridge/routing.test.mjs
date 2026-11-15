// Router contract: documents live in a window go to that window's renderer over the IPC protocol
// (docs/bridge-protocol.md), everything else to the headless host; one writer per document.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startTestBridge, fakeWindow, collectEvents} from './helpers.mjs';

test('a document claimed by a window is routed to it; headless drops its copy', async () => {
  const t = await startTestBridge();
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'quill', title: 'Live'});
    await t.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'Headless edit'}});
    assert.equal(t.headless.has(doc), true);
    const w = await fakeWindow(t, 7, {files: [await t.store.get(doc)]});
    w.hello();
    w.claim();
    await new Promise(r => setTimeout(r, 50));
    assert.equal(t.headless.has(doc), false, 'headless released the document');
    assert.equal(t.router.owner(doc), 7);
    const run = await t.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'Window edit'}});
    assert.equal(run.undoLabel, 'Automation: Rename Document');
    assert.equal(w.received.at(-1).method, 'engine.execute');
    assert.equal(w.received.at(-1).origin, 'bridge');
    assert.equal(w.session.get(doc).file.title, 'Window edit');
    // The window saves through its own autosave; the store is untouched by the bridge.
    assert.equal((await t.store.get(doc)).title, 'Headless edit');
    const ui = await t.rpc('ui.inspect', {});
    assert.deepEqual(ui, {doc, tab: 'home'});
    const listed = (await t.rpc('documents.list', {})).documents.find(d => d.id === doc);
    assert.equal(listed.owner, 'window');
    assert.equal(listed.window, 7);
    const describe = await t.rpc('app.describe', {});
    assert.deepEqual(describe.windows.map(x => [x.window, x.live, x.documents]), [[7, true, [doc]]]);
    let r = await t.raw('documents.delete', {doc});
    assert.equal(r.body.error.code, 'conflict');
    // Errors from the window keep their code and data.
    r = await t.raw('engine.execute', {doc, command: 'bridgetest.wipe', params: {}});
    assert.equal(r.status, 428);
    const nonce = r.body.error.data.nonce;
    await t.rpc('engine.execute', {doc, command: 'bridgetest.wipe', params: {}, approval: {nonce}});
    const toast = w.received.find(m => m.method === 'ui.toast');
    assert.deepEqual(toast, {id: null, method: 'ui.toast', params: {text: 'Automation: Replace the title of "Window edit" with "Wiped"', risk: 'destructive'}, origin: 'bridge'});
    // bye: the window no longer has documents live, so requests go headless again.
    t.router.onNotify(7, {type: 'bye'});
    const back = await t.rpc('engine.execute', {doc, command: 'bridgetest.title'});
    assert.equal(back.result.title, 'Headless edit');
    assert.equal(t.headless.has(doc), true);
  } finally { await t.close(); }
});

test('window events reach SSE with owner window; replies are only accepted from the asked window', async () => {
  const t = await startTestBridge({timeoutMs: 300});
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'quill', title: 'Events'});
    const w = await fakeWindow(t, 'w1', {files: [await t.store.get(doc)]});
    w.hello(); w.claim();
    const stream = await collectEvents(t, `?doc=${doc}&types=doc.changed`, ev => ev.length >= 1);
    await t.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'Seen'}});
    const [event] = await stream.done;
    assert.equal(event.owner, 'window');
    assert.equal(event.window, 'w1');
    assert.equal(event.version, 1);
    // A reply from another window, or for an unknown id, is dropped.
    assert.equal(t.router.onReply('w2', {id: 'r1', ok: true, result: 1}), false);
    assert.equal(t.router.onReply('w1', {id: 'r999', ok: true, result: 1}), false);
    assert.equal(t.router.onNotify('nobody', {type: 'hello'}), false);
    assert.equal(t.router.onNotify('w1', {type: 'event', event: {type: 'secret.leak', doc}}), false);
    // A silent window times out.
    w.answer = false;
    const pending = t.raw('engine.execute', {doc, command: 'bridgetest.title'});
    const id = await new Promise(resolve => { const tick = () => (w.received.at(-1)?.method === 'engine.execute' && w.received.length ? resolve(w.received.at(-1).id) : setTimeout(tick, 5)); tick(); });
    assert.equal(t.router.onReply('intruder', {id, ok: true, result: {forged: true}}), false);
    const r = await pending;
    assert.equal(r.status, 504);
    assert.equal(r.body.error.code, 'timeout');
    // A window that closes rejects what it owed.
    const again = t.raw('engine.execute', {doc, command: 'bridgetest.title'});
    await new Promise(resolve => setTimeout(resolve, 20));
    t.router.detachWindow('w1');
    const closed = await again;
    assert.equal(closed.body.error.code, 'unavailable');
  } finally { await t.close(); }
});

test('documents.open asks the window manager, waits for the claim, and reports legacy windows as not live', async () => {
  const opened = [];
  let t;
  const fake = {};
  t = await startTestBridge({
    helloGraceMs: 150,
    openDocument: async (doc, opts) => {
      opened.push({doc, ...opts});
      if (opts.show === false) {
        // A RendererBridge window: says hello and claims the document shortly after creation.
        fake.w = await fakeWindow(t, 'hidden', {files: [await t.store.get(doc)]});
        setTimeout(() => { fake.w.hello(); fake.w.claim(); }, 30);
        return {window: 'hidden', shown: false};
      }
      t.router.attachWindow({id: 'legacy', send: () => {}});
      return {window: 'legacy', shown: true};
    },
    capture: async (windowId, params) => ({png: 'iVBORw0KGgo=', width: 1, height: 1, window: windowId, scale: params.scale ?? 1}),
  });
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'quill', title: 'Open me'});
    const hidden = await t.rpc('documents.open', {doc, show: false});
    assert.deepEqual({...hidden, version: undefined}, {doc, kind: 'quill', title: 'Open me', window: 'hidden', shown: false, live: true, version: undefined});
    assert.deepEqual(opened[0], {doc, show: false, windowId: undefined, kind: 'quill'});
    const shot = await t.rpc('ui.capture', {doc, scale: 0.5});
    assert.equal(shot.window, 'hidden');
    assert.equal(shot.scale, 0.5);
    const other = await t.rpc('documents.create', {kind: 'quill', title: 'Legacy'});
    const legacy = await t.rpc('documents.open', {doc: other.doc});
    assert.equal(legacy.live, false);
    assert.equal(legacy.window, 'legacy');
    let r = await t.raw('documents.open', {doc: 'missing'});
    assert.equal(r.body.error.code, 'not_found');
    r = await t.raw('documents.open', {doc, extra: 1});
    assert.equal(r.body.error.code, 'invalid_params');
  } finally { await t.close(); }
});

test('without a window manager documents.open loads the document headless', async () => {
  const t = await startTestBridge();
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'slate'});
    const r = await t.rpc('documents.open', {doc});
    assert.equal(r.owner, 'headless');
    assert.equal(r.live, false);
    assert.equal((await t.raw('ui.capture', {})).body.error.code, 'unavailable');
  } finally { await t.close(); }
});
