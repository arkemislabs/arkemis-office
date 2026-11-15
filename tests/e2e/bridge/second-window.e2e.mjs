// A second document opened through the bridge gets its own window, and that window goes live
// (says hello and claims the document) in test mode, as the first does.
//
// Behaviour fidelity: Word, Excel and PowerPoint open every document in its own window; the
// bridge must drive each of them. What this proves: documents.open of a second document answers
// live:true and its window answers ui.* and document methods (ui.inspect, document.read) while
// the first window keeps its document. Not covered: more than two windows, or closing order.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFile} from '../../../core/model.mjs';
import {devRenderer, launchApp} from '../harness.mjs';

test('bridge: a second documents.open window becomes live in test mode', {timeout: 200_000}, async () => {
  const a = createFile('slate', 'First notebook', {schema: 2}); a.id = 'nb-first';
  const b = createFile('slate', 'Second notebook', {schema: 2}); b.id = 'nb-second';
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product: 'slate', flow: 'bridge/second-window', files: [a, b], renderer});
  const log = () => `\n--- app log ---\n${app.log.join('').slice(-3000)}`;
  try {
    await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 45_000})
      .catch(e => { throw new Error(e.message + log()); });
    const first = await app.rpc('documents.open', {doc: a.id, show: true});
    assert.equal(first.live, true, JSON.stringify(first));
    const second = await app.rpc('documents.open', {doc: b.id, show: true});
    assert.equal(second.live, true, `second window live: ${JSON.stringify(second)}${log()}`);
    assert.notEqual(second.window, first.window, 'each document has its own window');
    const ui = await app.until(async () => { const r = await app.rpc('ui.inspect', {doc: b.id}); return r.doc?.id === b.id ? r : null; }, {timeout: 30_000});
    assert.equal(ui.doc.id, b.id);
    const read = await app.rpc('document.read', {doc: b.id, address: '/', as: 'json'});
    assert.equal(read.doc, b.id);
    const firstUi = await app.rpc('ui.inspect', {doc: a.id});
    assert.equal(firstUi.doc.id, a.id);
    const described = await app.rpc('app.describe');
    assert.equal(described.windows.filter(w => w.live).length >= 2, true, JSON.stringify(described.windows));
    await app.capture('second-window', {window: second.window});
  } finally {
    await app.close();
  }
});
