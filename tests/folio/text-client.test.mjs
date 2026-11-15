// core/folio/lib/text-client.mjs and text-ops.mjs: the text operations run in the folio text worker when the renderer can start one, and in the calling
// thread (in slices) otherwise. The worker here is a stand-in that answers the way src/workers/folio-text.ts does (the same messages, the same errors).
//
// Behaviour fidelity (docs/behaviour-fidelity.md): printcraft has no worker (its UI is native); the requirement is the product's: a big page never stalls the
// window, and a worker that cannot start or dies leaves the editor working. These tests pin both: the calls go to the worker, a document error comes back
// as the same error, a dying worker is given up and the call is made in the thread, and the bytes a worker returns are what the file becomes.
import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {PDFDocument} from 'pdf-lib';
import {callText, resetTextClient} from '../../core/folio/lib/text-client.mjs';
import {OPS} from '../../core/folio/lib/text-ops.mjs';
import {editPdf, base64} from '../../core/folio/fixtures.mjs';
import {pageBlocks} from '../../core/folio/lib/text-edit.mjs';

const realWorker = globalThis.Worker;
const realDocument = globalThis.document;
afterEach(() => { globalThis.Worker = realWorker; globalThis.document = realDocument; resetTextClient(); });

/** A stand-in for new Worker('./folio-text.js'): the same protocol as src/workers/folio-text.ts. */
function install({die = false} = {}) {
  const made = [];
  globalThis.document = {};
  globalThis.Worker = class {
    constructor(url, options) { this.url = url; this.options = options; made.push(this); }
    postMessage({id, op, args}) {
      if (die) { setTimeout(() => this.onerror?.({message: 'boom'}), 0); return; }
      this.sent = (this.sent ?? 0) + 1;
      (async () => {
        try {
          const result = await OPS[op](args);
          this.onmessage?.({data: {id, ok: true, result}});
        } catch (err) { this.onmessage?.({data: {id, ok: false, error: {message: err.message, code: err.code ?? 'invalid_params', path: err.path}}}); }
      })();
    }
    terminate() { this.dead = true; }
  };
  return made;
}

test('without a worker the call is made in the thread', async () => {
  const b64 = base64(await editPdf());
  const out = await callText('blocks', {base64: b64, sourceIndex: 0});
  assert.equal(out.via, 'thread');
  assert.equal(out.blocks.length, 5);
});

test('with a worker the call goes to it, as new Worker(\'./folio-text.js\', {type: \'module\'}), and one worker serves every call', async () => {
  const made = install();
  const b64 = base64(await editPdf());
  const first = await callText('blocks', {base64: b64, sourceIndex: 0});
  const second = await callText('blocks', {base64: b64, sourceIndex: 0});
  assert.equal(first.via, 'worker');
  assert.equal(second.via, 'worker');
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].url, made[0].options], ['./folio-text.js', {type: 'module'}]);
  assert.equal(made[0].sent, 2);
  assert.deepEqual(first.blocks.map(b => b.text), second.blocks.map(b => b.text));
});

test('a rewrite in the worker returns the new file and the paragraph it became', async () => {
  install();
  const b64 = base64(await editPdf());
  const listed = await callText('blocks', {base64: b64, sourceIndex: 0});
  const body = listed.blocks[1];
  const out = await callText('replace', {base64: b64, sourceIndex: 0, key: body.key, text: 'Short.', style: {}});
  assert.equal(out.via, 'worker');
  assert.ok(out.bytes instanceof Uint8Array && out.bytes.length > 100);
  assert.equal(out.after.text, 'Short.');
  const doc = await PDFDocument.load(out.bytes);
  assert.equal(pageBlocks(doc, doc.getPage(0)).blocks[1].text, 'Short.');
  const moved = await callText('move', {bytes: out.bytes, sourceIndex: 0, key: out.after.key, offset: [10, 0]});
  assert.ok(Math.abs(moved.after.rect[0] - out.after.rect[0] - 10) < 0.05, `${moved.after.rect} vs ${out.after.rect}`);
});

test('an error about the document comes back as the same error and the worker stays', async () => {
  const made = install();
  const b64 = base64(await editPdf());
  await assert.rejects(() => callText('replace', {base64: b64, sourceIndex: 0, key: {text: 'No such words', rect: [0, 0, 1, 1]}, text: 'x'}), e => e.name === 'TextError' && e.code === 'not_found' && /no longer on the page/.test(e.message));
  const again = await callText('blocks', {base64: b64, sourceIndex: 0});
  assert.equal(again.via, 'worker');
  assert.equal(made.length, 1);
});

test('a worker that dies is given up and the call is made in the thread, now and afterwards', async () => {
  const made = install({die: true});
  const b64 = base64(await editPdf());
  const out = await callText('blocks', {base64: b64, sourceIndex: 0});
  assert.equal(out.via, 'thread');
  assert.equal(made[0].dead, true);
  const next = await callText('blocks', {base64: b64, sourceIndex: 0});
  assert.equal(next.via, 'thread');
  assert.equal(made.length, 1, 'no second worker is started');
});

test('a worker that cannot be created leaves the editor working in the thread', async () => {
  globalThis.document = {};
  globalThis.Worker = class { constructor() { throw new Error('no such file'); } };
  const out = await callText('blocks', {base64: base64(await editPdf()), sourceIndex: 0});
  assert.equal(out.via, 'thread');
});
