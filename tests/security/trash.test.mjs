// Security audit M5: closed documents expire from the vault trash after 30 days; a password-protected PDF (a decrypted working
// copy holding its file key) is never put there; the trash can be emptied.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createFile} from '../../core/model.mjs';

const require = createRequire(import.meta.url);
const {createStore} = require('../../electron/store.cjs');
const DAY = 86_400_000;

async function vault() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-trash-'));
  const dir = path.join(base, 'documents');
  const store = await createStore(dir);
  return {base, dir, trash: path.join(dir, 'trash'), store, done: () => fs.rm(base, {recursive: true, force: true})};
}
const names = async trash => (await fs.readdir(trash).catch(() => [])).filter(n => n.endsWith('.json'));

test('a closed document goes to the trash and leaves it after 30 days', async () => {
  const {trash, store, done} = await vault();
  try {
    const saved = await store.save(createFile('quill', 'Report'));
    await store.remove(saved.id, saved.revision);
    assert.equal((await names(trash)).length, 1);
    assert.equal(await store.purgeTrash(Date.now() + 29 * DAY), 0, 'still inside the 30 days');
    assert.equal((await names(trash)).length, 1);
    assert.equal(await store.purgeTrash(Date.now() + 31 * DAY), 1);
    assert.equal((await names(trash)).length, 0);
  } finally { await done(); }
});

test('a password-protected PDF is deleted on close, never trashed', async () => {
  const {dir, trash, store, done} = await vault();
  try {
    const secured = createFile('folio', 'Secret');
    secured.content.security = {v: 5, r: 6, key: 'ab'.repeat(32), o: '', u: ''};
    const locked = createFile('folio', 'Locked');
    locked.content.locked = {sourceBase64: 'AAAA'};
    for (const file of [secured, locked]) {
      const saved = await store.save(file);
      await store.remove(saved.id, saved.revision);
      await assert.rejects(fs.access(path.join(dir, `${saved.id}.json`)));
    }
    assert.deepEqual(await names(trash), []);
  } finally { await done(); }
});

test('a protected PDF an earlier version left in the trash is purged at the next start', async () => {
  const {base, dir, trash, done} = await vault();
  try {
    const secured = createFile('folio', 'Old secret');
    secured.content.security = {v: 5, r: 6, key: 'cd'.repeat(32), o: '', u: ''};
    await fs.mkdir(trash, {recursive: true});
    const plain = createFile('quill', 'Fine');
    await fs.writeFile(path.join(trash, `${secured.id}-${Date.now()}.json`), JSON.stringify(secured));
    await fs.writeFile(path.join(trash, `${plain.id}-${Date.now()}.json`), JSON.stringify(plain));
    const store = await createStore(dir);
    await store.purgeTrash();
    const left = await names(trash);
    assert.equal(left.length, 1);
    assert.ok(left[0].startsWith(plain.id));
  } finally { await done(); }
});

test('clearTrash empties the trash (an uninstall or reset)', async () => {
  const {trash, store, done} = await vault();
  try {
    const saved = await store.save(createFile('quill', 'Gone'));
    await store.remove(saved.id, saved.revision);
    await store.clearTrash();
    assert.deepEqual(await names(trash), []);
  } finally { await done(); }
});

// ---- OneNote: a closed notebook never leaves an unlocked section's plain pages in the trash ----
import {textSession} from '../slate/format-helpers.mjs';

const SECRET = 'SECRET-LIGHTHOUSE-PLANS';
const PASSWORD = 'correct horse battery';

async function unlockedNotebook() {
  const t = await textSession([`${SECRET} are in the diary`], {
    notebook: {sections: [{name: 'Private', pages: ['Diary']}, {name: 'Public', pages: ['Home']}]},
    selection: p => ({ranges: [{anchor: `/pg:${p}`, focus: `/pg:${p}`}], primary: 0}),
  });
  const sec = Object.values(t.content.sections).find(x => x.name === 'Private').id;
  await t.exec('password.set', {sectionId: sec, password: PASSWORD});
  assert.equal(t.content.sections[sec].locked === true, false, 'the section is unlocked');
  assert.ok(JSON.stringify(t.content).includes(SECRET), 'its pages are in memory');
  const file = createFile('slate', 'Private notebook', {schema: 2});
  file.content = structuredClone(t.content);
  return file;
}
const trashText = async trash => (await Promise.all((await names(trash)).map(n => fs.readFile(path.join(trash, n), 'utf8')))).join('\n');

test('a notebook with an unlocked protected section goes to the trash sealed', async () => {
  const {trash, store, done} = await vault();
  try {
    const file = await unlockedNotebook();
    const saved = await store.save(file);
    await store.remove(saved.id, saved.revision);
    const kept = await trashText(trash);
    assert.ok(kept.includes('"Private notebook"') || kept.includes('Private'), 'the notebook is kept');
    assert.equal(kept.includes(SECRET), false, 'no plain page text');
    assert.equal(kept.includes('"locked":true'), true, 'the section is sealed as a save writes it');
    assert.match(kept, /AES-256-GCM/);
  } finally { await done(); }
});

test('a notebook an earlier version trashed unlocked is sealed in place at the next start', async () => {
  const {dir, trash, done} = await vault();
  try {
    const file = await unlockedNotebook();
    await fs.mkdir(trash, {recursive: true});
    await fs.writeFile(path.join(trash, `${file.id}-${Date.now()}.json`), JSON.stringify(file));
    assert.ok((await trashText(trash)).includes(SECRET));
    const store = await createStore(dir);
    await store.purgeTrash();
    const kept = await trashText(trash);
    assert.equal(kept.includes(SECRET), false);
    assert.match(kept, /AES-256-GCM/);
  } finally { await done(); }
});
