// Shared steps for the file lifecycle E2E flows (tests/e2e/common/file-*.e2e.mjs). The app runs in
// test mode (ARKEMIS_STUDIO_TEST=1), where main answers the system Save/Open dialogs and message
// boxes from a scripted queue (test.dialogs) and logs every request; production always shows the
// real dialogs. Everything goes through the bridge: no pointer, no key presses, no screenshots.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {devRenderer, launchApp} from '../harness.mjs';

export const now = '2026-10-30T09:00:00.000Z';
export const fileOf = (kind, title, content) => ({id: randomUUID(), schema: 1, kind, title, createdAt: now, updatedAt: now, revision: 0, starred: false, content, links: []});

/** A folder outside the vault, as the person's Documents folder. */
export async function documentsFolder(name) {
  return fs.mkdtemp(path.join(os.tmpdir(), `arkemis-e2e-${name}-`));
}

/** Launch `product` with the new shell (devRenderer) and wait for a live window. */
export async function start(product, flow, opts = {}) {
  const renderer = await devRenderer({newHost: true});
  const app = await launchApp({product, flow: `common/${flow}`, renderer, ...opts});
  app.logTail = () => `\n--- app log ---\n${app.log.join('').slice(-4000)}`;
  await app.until(async () => (await app.rpc('app.describe')).windows?.some(w => w.live) || null, {timeout: 60_000})
    .catch(e => { throw new Error(e.message + app.logTail()); });
  return app;
}

/** Open `doc` in a window and wait until its shell answers ui.inspect. */
export async function show(app, doc) {
  await app.rpc('documents.open', {doc, show: true});
  await app.until(async () => {
    const ui = await app.rpc('ui.inspect', {doc});
    return ui.doc?.id === doc && ui.tabs?.length ? ui : null;
  }, {timeout: 45_000}).catch(e => { throw new Error(e.message + app.logTail()); });
}

/** Queue scripted answers for the next system dialogs and clear the log. */
export const script = (app, ...answers) => app.rpc('test.dialogs', {clear: true, clearLog: true, script: answers});
/** The dialogs main was asked for since the last script(). */
export const asked = async app => (await app.rpc('test.dialogs', {})).log;
export const state = app => app.rpc('test.state', {});
export const binding = async (app, doc) => (await state(app)).bindings[doc] ?? null;
export const windowOf = async (app, doc) => (await state(app)).windows.find(w => w.docs.includes(doc)) ?? null;

export async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }

/** A change the file does not have yet (document properties: an edit every app has). */
export async function edit(app, doc, subject = `edited ${Date.now()}`) {
  const r = await app.rpc('engine.execute', {doc, command: 'file.properties', params: {subject}});
  assert.ok(r.version > 0);
  return r;
}

/** The working copy main keeps in the vault (AutoRecover). */
export async function vaultCopy(app, doc) {
  return JSON.parse(await fs.readFile(path.join(app.data, 'documents', `${doc}.json`), 'utf8'));
}

/** Wait until the shell shows the Save Changes prompt, and return it. */
export async function savePrompt(app, doc) {
  return app.until(async () => {
    const d = await app.rpc('ui.dialog.get', {doc}).catch(() => null);
    return d && /save|close/i.test(String(d.id)) ? d : null;
  }, {timeout: 15_000});
}

/** Press a dialog button over the bridge; a discard asks for approval first (destructive), which the test gives. */
export async function press(app, doc, button) {
  // Save / Don't Save close the document, and with it the window that would have answered.
  const closing = e => (e.code === 'unavailable' && /window closed/i.test(e.message) ? {closed: true} : Promise.reject(e));
  try { return await app.rpc('ui.dialog.submit', {doc, button}); } catch (e) {
    if (e.code !== 'approval_required') return closing(e);
    return app.rpc('ui.dialog.submit', {doc, button, approval: {nonce: e.data.nonce}}).catch(closing);
  }
}

export async function run(fn, app) {
  try { return await fn(); } catch (e) {
    if (app) e.message += app.logTail();
    throw e;
  } finally { if (app) await app.close(); }
}
