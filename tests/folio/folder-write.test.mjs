// electron/folder-files.cjs: files written into a folder the person chose.
//
// Behaviour: main writes only inside a folder picked in the system folder dialog this session, only under a plain file name (no separator, no "..",
// not absolute, no reserved characters), never replaces a file (a taken name is numbered), and the result is directly inside the folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const {plainFileName, createFolderWriter} = createRequire(import.meta.url)('../../electron/folder-files.cjs');
const bytes = text => Buffer.from(text);

test('plain file names: no folders, no "..", not absolute, no reserved characters, no trailing dot or space', () => {
  const back = String.fromCharCode(92);
  for (const ok of ['page_1.png', 'My file (2).pdf', 'é.txt', 'a.b.c']) assert.equal(plainFileName(ok), true, ok);
  for (const bad of ['', '.', '..', '../x.png', 'a/b.png', `a${back}b.png`, `${back}x.png`, '/etc/passwd', 'C:x.png', 'a:b', 'a*b', 'x.', 'x ', 'a\u0000b', 'x'.repeat(201), null, 5, {}]) assert.equal(plainFileName(bad), false, String(bad));
  assert.equal(plainFileName(`..${back}..${back}evil.png`), false);
  for (const device of ['CON', 'nul.png', 'Com1.txt', 'LPT9', 'aux.tar.gz']) assert.equal(plainFileName(device), false, device);
  for (const ok of ['console.png', 'nulls.txt', 'com10.png']) assert.equal(plainFileName(ok), true, ok);
});

test('only a folder picked this session can be written to, and only by plain names; nothing is replaced', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-write-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-outside-'));
  try {
    const w = createFolderWriter(new Set());
    await assert.rejects(w.write(dir, 'a.png', bytes('x')), /folder chosen in the folder dialog/, 'a folder nobody picked');
    w.allow(dir);
    const first = await w.write(dir, 'a.png', bytes('one'));
    assert.equal(first.name, 'a.png');
    assert.equal(path.dirname(first.path), path.resolve(dir));
    const second = await w.write(dir, 'a.png', bytes('two'));
    assert.equal(second.name, 'a (2).png', 'a taken name is numbered');
    assert.equal(await fs.readFile(first.path, 'utf8'), 'one', 'the first file is not replaced');
    assert.equal((await w.write(dir, 'a.png', bytes('three'))).name, 'a (3).png');
    for (const name of ['../escape.png', 'sub/x.png', path.join(outside, 'abs.png'), '..', '']) await assert.rejects(w.write(dir, name, bytes('x')), /plain name/, name);
    assert.deepEqual(await fs.readdir(outside), [], 'nothing was written outside the folder');
    await assert.rejects(w.write(path.join(dir, '..'), 'x.png', bytes('x')), /folder chosen/, 'the parent of a chosen folder is not chosen');
    await assert.rejects(w.write(outside, 'x.png', bytes('x')), /folder chosen/);
    await assert.rejects(w.write(dir, 'x.png', 'not bytes'), /bytes/);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['a (2).png', 'a (3).png', 'a.png']);
  } finally { await fs.rm(dir, {recursive: true, force: true}); await fs.rm(outside, {recursive: true, force: true}); }
});
