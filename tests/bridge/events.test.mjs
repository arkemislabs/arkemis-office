// /v2/events (Server-Sent Events) contract of the test transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startTestBridge, collectEvents} from './helpers.mjs';

test('SSE streams doc.changed and doc.saved with versions, addresses and the owner; filters by doc and type', async () => {
  const t = await startTestBridge();
  try {
    const a = await t.rpc('documents.create', {kind: 'quill', title: 'A'});
    const b = await t.rpc('documents.create', {kind: 'quill', title: 'B'});
    const all = await collectEvents(t, `?doc=${a.doc}`, ev => ev.some(e => e.type === 'doc.saved'));
    const changedOnly = await collectEvents(t, '?types=doc.changed', ev => ev.length >= 2);
    assert.equal(all.status, 200);
    await t.rpc('engine.execute', {doc: b.doc, command: 'file.rename', params: {name: 'B2'}});
    await t.rpc('engine.execute', {doc: a.doc, command: 'file.rename', params: {name: 'A2'}});
    const events = await all.done;
    assert.ok(events.every(e => e.doc === a.doc), 'only document A');
    const changed = events.find(e => e.type === 'doc.changed');
    assert.equal(changed.version, 1);
    assert.equal(changed.owner, 'headless');
    assert.equal(changed.origin, 'bridge');
    assert.ok(Array.isArray(changed.changed) && changed.changed.length);
    const saved = events.find(e => e.type === 'doc.saved');
    assert.equal(saved.storeRevision, 2);
    const typed = await changedOnly.done;
    assert.deepEqual(typed.map(e => e.type), ['doc.changed', 'doc.changed']);
    assert.equal((await fetch(t.base + '/v2/events?types=bogus', {headers: t.auth})).status, 400);
    assert.equal((await fetch(t.base + '/v2/events', {method: 'POST', headers: t.auth})).status, 405);
  } finally { await t.close(); }
});

test('SSE replays missed events after Last-Event-ID', async () => {
  const t = await startTestBridge();
  try {
    const {doc} = await t.rpc('documents.create', {kind: 'grid'});
    await t.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'One'}});
    await t.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'Two'}});
    const controller = new AbortController();
    const response = await fetch(t.base + '/v2/events?types=doc.changed', {headers: {...t.auth, 'Last-Event-ID': '0'}, signal: controller.signal});
    const reader = response.body.getReader();
    let text = '';
    while (!(text.match(/event: doc\.changed/g)?.length >= 2)) text += new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    assert.match(text, /"version":1/);
    assert.match(text, /"version":2/);
  } finally { await t.close(); }
});

