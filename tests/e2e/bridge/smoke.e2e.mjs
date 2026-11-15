// Bridge smoke flow: background start (no window), headless edit through the kernel, a hidden
// window opened by the bridge, and visual evidence through ui.capture. No input devices.
import test from 'node:test';
import assert from 'node:assert/strict';
import {launchApp} from '../harness.mjs';

test('bridge: --background start, headless edit, hidden window, capture', {timeout: 180_000}, async () => {
  const app = await launchApp({product: 'quill', args: ['--background'], flow: 'bridge/smoke'});
  try {
    const describe = await app.rpc('app.describe');
    assert.equal(describe.protocol, 2);
    assert.equal(describe.product, 'quill');
    assert.deepEqual(describe.windows, [], 'a background start shows no window');
    const {doc} = await app.rpc('documents.create', {title: 'E2E draft'});
    const run = await app.rpc('engine.execute', {doc, command: 'file.rename', params: {name: 'E2E renamed'}, baseVersion: 0});
    assert.equal(run.undoLabel, 'Automation: Rename Document');
    const listed = await app.rpc('documents.list', {});
    assert.equal(listed.documents.find(d => d.id === doc).title, 'E2E renamed');
    const opened = await app.rpc('documents.open', {doc, show: false});
    assert.equal(opened.shown, false);
    const windows = await app.until(async () => {
      const d = await app.rpc('app.describe');
      return d.windows.length ? d.windows : null;
    });
    assert.equal(windows[0].shown, false);
    const shot = await app.capture('hidden-window');
    assert.ok(shot.width > 0 && shot.height > 0);
  } finally {
    await app.close();
  }
});
