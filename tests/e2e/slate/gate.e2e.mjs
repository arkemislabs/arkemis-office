// Slate's gate (docs/architecture.md 17.5), the flows the other Slate suites don't already cover: a note
// typed on a new page (a click, then typing, through the bridge's synthetic input), a notebook created
// in a folder (File > New Notebook, no system dialog: the folder is given), the typed note saved into
// the notebook's folder as files, the notebook closed and opened again from its path with the note
// intact, Print through the print path, and every address the notebook lists read back over the
// bridge. Tabs, dialogs, tags, history, review, equations, view and the dialog sweep are in the other
// Slate suites; OneNote has no Save As formats (a notebook is a folder), so there are none here.
//
//   npm run build && node --test tests/e2e/slate/gate.e2e.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {documentsFolder, exists, script, show, start, run} from '../common/file-helpers.mjs';
import {createContent} from '../../../core/slate/schema.mjs';

const TEXT = 'Gate check for the Slate notebook.';
const NOW = new Date().toISOString();
const vaultNotebook = () => {
  const content = createContent('Vault Notebook', {now: NOW});
  return {id: 'slate-gate-vault', schema: 2, kind: 'slate', title: content.notebook.name, revision: 0, createdAt: NOW, updatedAt: NOW, starred: false, links: [], content};
};

/** Every file (path -> text) under a folder. */
async function everyFile(dir) {
  const out = [];
  for (const d of await fs.readdir(dir, {withFileTypes: true}).catch(() => [])) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...await everyFile(p));
    else out.push([p, await fs.readFile(p, 'utf8')]);
  }
  return out;
}
/** The page the selection is on (the click put the caret on it), and its content as JSON text. */
const pageOf = async (app, doc) => {
  const sel = (await app.rpc('selection.get', {doc})).selection.ranges[0]?.anchor ?? '';
  return /^\/pg:[^/]+/.exec(sel)?.[0] ?? null;
};
const pageText = async (app, doc, page) => (page ? JSON.stringify((await app.rpc('document.read', {doc, address: page, as: 'json'})).value) : '');

test('slate gate: type a note, create a notebook folder, see it saved as files, close and reopen it, Print, read back every address', {timeout: 600_000}, async () => {
  const folder = await documentsFolder('slate-gate');
  const app = await start('slate', 'slate-gate', {files: [vaultNotebook()]});
  await run(async () => {
    // A notebook (the vault's, new and empty), a click on the page and typing. OneNote makes sections and pages, not files, so there is no documents.create.
    const doc = 'slate-gate-vault';
    await show(app, doc);
    await app.rpc('ui.pointer', {doc, action: 'click', x: 120, y: 520});
    await app.rpc('ui.type', {doc, text: TEXT});
    const page = await app.until(async () => { const p = await pageOf(app, doc); return p && (await pageText(app, doc, p)).includes(TEXT) ? p : null; }, {timeout: 15_000});
    assert.ok(page, 'the note is on a page');
    await app.capture('01-typed', {doc});

    // File > New > Notebook: a notebook folder is created where it is told, and opens in its own window.
    const target = path.join(folder, 'Gate Notebook');
    await script(app, {type: 'save', path: target});
    const made = (await app.rpc('engine.execute', {doc, command: 'notebook.new', params: {}})).result;
    assert.ok((await (await import('../common/file-helpers.mjs')).asked(app)).some(a => a.type === 'save'), 'the system New Notebook dialog was asked');
    assert.ok(made.doc && made.path, `the notebook was created: ${JSON.stringify(made)}`);
    assert.equal(path.basename(made.path), 'Gate Notebook');
    await show(app, made.doc);
    assert.ok(await exists(path.join(made.path, 'notebook.json')), 'the folder has its table of contents');
    await app.rpc('ui.pointer', {doc: made.doc, action: 'click', x: 120, y: 520});
    await app.rpc('ui.type', {doc: made.doc, text: TEXT});
    const madePage = await app.until(async () => { const p = await pageOf(app, made.doc); return p && (await pageText(app, made.doc, p)).includes(TEXT) ? p : null; }, {timeout: 15_000});
    // The note reaches the folder by itself (no Save step).
    await app.until(async () => (await everyFile(made.path)).some(([, body]) => body.includes(TEXT)) || null, {timeout: 20_000});
    const files = await everyFile(made.path);
    assert.ok(files.some(([f]) => f.endsWith('section.json')) && files.some(([f]) => /p[a-z0-9]+\.json$/.test(path.basename(f))), 'the sections and pages are files');
    await app.capture('02-notebook-folder', {doc: made.doc});

    // Close its window, then File > Open Notebook on the folder: the notebook comes back with its note (the vault already holds it, so it is brought forward; reading a folder cold is tests/slate/foundation-folder).
    await app.rpc('test.window.close', {doc: made.doc});
    await app.until(async () => !(await app.rpc('test.state', {})).windows.some(w => w.docs.includes(made.doc)) || null, {timeout: 20_000});
    const opened = (await app.rpc('engine.execute', {doc, command: 'notebook.open', params: {path: made.path}})).result;
    assert.ok(opened.doc, 'the notebook opened again');
    assert.equal(opened.doc, made.doc, 'the same notebook came forward');
    await show(app, opened.doc).catch(async e => { throw new Error(`${e.message}
opened: ${JSON.stringify(opened)}
describe: ${JSON.stringify(await app.rpc('app.describe'))}
state: ${JSON.stringify(await app.rpc('test.state', {}))}`); });
    assert.ok((await pageText(app, opened.doc, madePage)).includes(TEXT), 'the note survives the round trip through its folder');
    await app.capture('03-reopened', {doc: opened.doc});

    // Print: File > Print's command, through the print path (the test-mode script answers it).
    await script(app);
    await app.rpc('engine.execute', {doc: opened.doc, command: 'file.print', params: {copies: 1}}).catch(e => { if (e.code !== 'approval_required') throw e; });
    await app.capture('after-print', {doc: opened.doc});

    // The things this notebook can hold, each addressable over the bridge: a tag, a style, an equation, versions, a protected section.
    const exec = async (d, command, params = {}) => (await app.rpc('engine.execute', {doc: d, command, params})).result;
    const read = async (d, address, as = 'json') => (await app.rpc('document.read', {doc: d, address, as})).value;
    await exec(doc, 'tag.toggle', {tagId: 'important'});
    await exec(doc, 'style.apply', {style: 'heading-2'});
    await exec(doc, 'insert.equation', {preset: 'pythagorean-theorem'});
    const props = await read(doc, page, 'props');
    assert.equal(props.tags.length, 1, 'the page lists its tag');
    assert.equal((await read(doc, props.tags[0].address)).id, 'important', `${props.tags[0].address} reads back`);
    assert.equal((await read(doc, `${page}/b:${props.tags[0].block}`, 'props')).style, 'h2', 'the style of the paragraph reads back');
    assert.equal(props.equations.length, 1, 'the page lists its equation');
    assert.equal((await read(doc, props.equations[0].address, 'props')).linear, 'a^2+b^2=c^2', 'the equation reads back');
    assert.ok(Array.isArray((await read(doc, `${page}/meta`)).versions), 'the page lists its saved versions');
    const section = (await read(doc, `${page}/meta`)).section;
    assert.equal((await read(doc, section)).protected, false);
    await exec(doc, 'password.set', {sectionId: section.replace('/sec:', ''), password: 'gate-check-passphrase'});
    assert.deepEqual([(await read(doc, section)).protected, (await read(doc, section)).locked], [true, false], 'a protected section reads back as protected');
    await exec(doc, 'password.lock', {sectionId: section.replace('/sec:', '')});
    const locked = await read(doc, section);
    assert.deepEqual([locked.protected, locked.locked, locked.pages.length], [true, true, 0], 'a locked section reads back as locked, with no pages');
    await assert.rejects(app.rpc('document.read', {doc, address: page, as: 'json'}), /./, 'the pages of a locked section are not in the notebook');

    // Bridge read-back: every address the notebook lists, and the page typed on, reads back.
    for (const a of [`${madePage}`, `${madePage}/meta`]) assert.ok('value' in await app.rpc('document.read', {doc: opened.doc, address: a}), `${a} reads back`);
    for (const d of [doc, opened.doc]) {
      const tree = await app.rpc('document.inspect', {doc: d});
      const addresses = [];
      const walk = n => { if (n?.address) addresses.push(n.address); for (const k of n?.nodes ?? []) walk(k); };
      walk(tree);
      assert.ok(addresses.length > 1, `the notebook lists its parts: ${addresses}`);
      for (const address of addresses) {
        const r = await app.rpc('document.read', {doc: d, address});
        assert.ok(r && 'value' in r, `${address} reads back`);
      }
    }
  }, app);
});
