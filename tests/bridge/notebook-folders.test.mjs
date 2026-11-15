// electron/notebook-folders.cjs: Slate notebooks as folders on disk, in a real temp folder with
// scripted folder dialogs (design note F-slate--integrator--notebook-folders).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
//  1. What does the original do? OneNote's New Notebook asks for a name and a place and creates the
//     notebook's folder there; Open Notebook picks a folder; every change is saved into the folder.
//  2. What does this test prove? New Notebook creates the folder (refusing a non-empty one) and a
//     schema-2 Slate document pointing at it; Open Notebook reads a folder back (or brings forward
//     the document that already holds it); the folder IO stays inside notebook folders; the recent
//     notebooks list keeps the folders.
//  3. What is not covered here? The dialogs themselves (Electron) and the surface's autosave, which
//     the Slate foundation's tests and E2E cover.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {loadNotebook, saveNotebook} from '../../core/slate/lib/notebook-folder.mjs';

const require = createRequire(import.meta.url);
const {createNotebookFolders} = require('../../electron/notebook-folders.cjs');

function memoryStore() {
  const files = new Map();
  return {
    files,
    async list() { return [...files.values()].map(f => structuredClone(f)); },
    async save(file) {
      const current = files.get(file.id);
      if ((current?.revision ?? 0) !== file.revision) throw new Error('Revision conflict');
      const saved = {...structuredClone(file), revision: file.revision + 1};
      files.set(file.id, saved);
      return structuredClone(saved);
    },
  };
}

async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-folders-'));
  const answers = [];
  const asked = [];
  const store = memoryStore();
  const nb = createNotebookFolders({store, recentFile: path.join(base, 'vault', 'notebooks.json'), defaultFolder: async () => base,
    askFolder: async req => { asked.push(req); return answers.shift() ?? null; }});
  return {base, answers, asked, store, nb};
}

test('New Notebook creates the folder and a schema-2 document whose notebook lives there', async () => {
  const {base, answers, asked, store, nb} = await setup();
  try {
    answers.push(path.join(base, 'Course notes'));
    const r = await nb.create('new');
    assert.equal(asked[0].title, 'New Notebook');
    assert.equal(asked[0].mode, 'new');
    assert.equal(r.name, 'Course notes');
    assert.equal(r.alreadyOpen, false);
    const file = store.files.get(r.doc);
    assert.equal(file.schema, 2);
    assert.equal(file.kind, 'slate');
    assert.equal(file.content.notebook.name, 'Course notes');
    assert.equal(path.resolve(file.content.notebook.path), path.resolve(base, 'Course notes'));
    const names = await fs.readdir(path.join(base, 'Course notes'));
    assert.ok(names.includes('notebook.json'), names.join(','));
    // The folder reads back as the same notebook.
    const back = await loadNotebook(nb.fs, r.path);
    assert.deepEqual(Object.keys(back.content.pages).sort(), Object.keys(file.content.pages).sort());
    // The recent list holds the folder.
    const recent = await nb.recent();
    assert.equal(recent[0].name, 'Course notes');
    assert.equal(recent[0].missing, false);
    // Cancelling the dialog makes nothing.
    assert.equal(await nb.create('new'), null);
  } finally { await fs.rm(base, {recursive: true, force: true}); }
});

test('New Notebook refuses a folder that is not empty, and a file of that name', async () => {
  const {base, answers, nb} = await setup();
  try {
    await fs.mkdir(path.join(base, 'Busy'));
    await fs.writeFile(path.join(base, 'Busy', 'x.txt'), 'x');
    await fs.writeFile(path.join(base, 'Plain'), 'x');
    answers.push(path.join(base, 'Busy'));
    await assert.rejects(nb.create('new'), e => e.code === 'conflict' && /not empty/.test(e.message));
    answers.push(path.join(base, 'Plain'));
    await assert.rejects(nb.create('new'), e => e.code === 'conflict' && /already exists/.test(e.message));
  } finally { await fs.rm(base, {recursive: true, force: true}); }
});

test('Open Notebook reads a folder, and an open folder brings its document forward', async () => {
  const {base, answers, asked, store, nb} = await setup();
  try {
    answers.push(path.join(base, 'Shared'));
    const made = await nb.create('new');
    // Edit the notebook through the folder save (what the surface's autosave does), then open it as a new document.
    const content = store.files.get(made.doc).content;
    const next = structuredClone(content);
    const sec = next.tree[0];
    next.sections[sec].name = 'Renamed section';
    await saveNotebook(nb.fs, made.path, content, next);
    store.files.delete(made.doc);
    answers.push(path.join(base, 'Shared'));
    const opened = await nb.create('open');
    assert.equal(asked.at(-1).title, 'Open Notebook');
    assert.equal(opened.alreadyOpen, false);
    const file = store.files.get(opened.doc);
    assert.equal(file.schema, 2);
    assert.equal(file.content.sections[sec].name, 'Renamed section');
    assert.equal(path.resolve(file.content.notebook.path), path.resolve(base, 'Shared'));
    // The same folder again: its document, not a second copy.
    answers.push(path.join(base, 'Shared'));
    const again = await nb.create('open');
    assert.equal(again.doc, opened.doc);
    assert.equal(again.alreadyOpen, true);
    // From the recent list: no dialog.
    const before = asked.length;
    const recentOpen = await nb.create('open', {path: (await nb.recent())[0].path});
    assert.equal(recentOpen.doc, opened.doc);
    assert.equal(asked.length, before);
    // A folder that is not a notebook says so.
    await fs.mkdir(path.join(base, 'Empty'));
    answers.push(path.join(base, 'Empty'));
    await assert.rejects(nb.create('open'), /not a Slate notebook/);
  } finally { await fs.rm(base, {recursive: true, force: true}); }
});

test('folder IO stays inside notebook folders; a path the recent list does not hold is refused', async () => {
  const {base, answers, nb, store} = await setup();
  try {
    await fs.writeFile(path.join(base, 'secret.txt'), 'no');
    await assert.rejects(nb.fs.readText(path.join(base, 'secret.txt')), e => e.code === 'invalid_params');
    await assert.rejects(nb.create('open', {path: base}), e => e.code === 'invalid_params');
    answers.push(path.join(base, 'Mine'));
    const r = await nb.create('new');
    const inside = `${r.path}/scratch.json`;
    await nb.fs.writeText(inside, '{"a":1}');
    assert.equal(await nb.fs.readText(inside), '{"a":1}');
    await assert.rejects(nb.fs.writeText(`${r.path}/../escape.txt`, 'x'), e => e.code === 'invalid_params');
    await assert.rejects(nb.fs.rename(inside, path.join(base, 'moved.json')), e => e.code === 'invalid_params');
    await assert.rejects(nb.fs.remove(r.path), e => e.code === 'invalid_params');
    await nb.fs.remove(inside);
    assert.equal((await fs.readdir(r.path)).includes('scratch.json'), false);
    // A fresh session (no picks yet) still reaches a notebook folder the recent list holds (an earlier session's pick).
    const other = createNotebookFolders({store, recentFile: path.join(base, 'vault', 'notebooks.json'), askFolder: async () => null});
    assert.ok((await other.fs.list(r.path)).some(e => e.name === 'notebook.json'));
  } finally { await fs.rm(base, {recursive: true, force: true}); }
});
