// Security audit M1: a notebook document's own `path` (an imported .ark can say anything) never grants folder access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {validateContent, createContent} from '../../core/slate/schema.mjs';

const require = createRequire(import.meta.url);
const {createNotebookFolders} = require('../../electron/notebook-folders.cjs');

test('a vault notebook whose path names a victim folder grants nothing', async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'nb-grant-'));
  try {
    const victim = path.join(base, 'victim');
    await fs.mkdir(path.join(victim, 'Documents'), {recursive: true});
    await fs.writeFile(path.join(victim, 'Documents', 'keep.txt'), 'precious');
    const evil = {id: 'evil', kind: 'slate', schema: 2, content: {notebook: {path: victim}}};
    const nb = createNotebookFolders({store: {list: async () => [evil], save: async f => f}, recentFile: path.join(base, 'recent.json'), askFolder: async () => null});
    await assert.rejects(nb.fs.readText(path.join(victim, 'Documents', 'keep.txt')), e => e.code === 'invalid_params');
    await assert.rejects(nb.fs.writeText(path.join(victim, 'x.txt'), 'owned'), e => e.code === 'invalid_params');
    await assert.rejects(nb.fs.remove(path.join(victim, 'Documents')), e => e.code === 'invalid_params');
    await assert.rejects(nb.create('open', {path: victim}), e => e.code === 'invalid_params');
    assert.equal(await fs.readFile(path.join(victim, 'Documents', 'keep.txt'), 'utf8'), 'precious');
  } finally { await fs.rm(base, {recursive: true, force: true}); }
});

test('the notebook schema refuses a path that is not a plain absolute local path', () => {
  const make = p => { const c = createContent('x'); c.notebook.path = p; return c; };
  assert.doesNotThrow(() => validateContent(make(null)));
  assert.doesNotThrow(() => validateContent(make('C:/Users/me/Notes')));
  assert.doesNotThrow(() => validateContent(make('/home/me/notes')));
  const B = String.fromCharCode(92);
  const bads = ['relative/dir', `${B}${B}server${B}share${B}x`, '//server/share/x', `${B}${B}?${B}C:${B}x`, 'C:/a/../../b', '/a/../b', 'C:/ab' + String.fromCharCode(0) + 'c', ''];
  for (const bad of bads) assert.throws(() => validateContent(make(bad)), /notebook path/, JSON.stringify(bad));
});
