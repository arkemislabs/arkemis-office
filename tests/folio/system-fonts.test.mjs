// System fonts for a window. The PDF app's commands run in the window, which has no file system: the Unicode text (lib/unicode-text.mjs, core/common/lib/pdf-fonts.mjs) reads the
// operating system's fonts through the host (window.studio.files.readSystemFont, electron/system-fonts.cjs). Main reads only font files inside the system font folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {PDFDocument} from 'pdf-lib';
import {unicodeFor} from '../../core/folio/lib/unicode-text.mjs';

const require = createRequire(import.meta.url);
const {isSystemFont, readSystemFont, fontFolders} = require('../../electron/system-fonts.cjs');

test('only font files inside the font folders are readable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fonts-'));
  const folders = [path.resolve(dir) + path.sep];
  await fs.writeFile(path.join(dir, 'a.ttf'), 'font');
  await fs.writeFile(path.join(dir, 'a.txt'), 'text');
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'b.ttc'), 'collection');
  try {
    assert.equal(isSystemFont(path.join(dir, 'a.ttf'), folders), true);
    assert.equal(isSystemFont(path.join(dir, 'sub', 'b.ttc'), folders), true, 'a font in a subfolder');
    assert.equal(isSystemFont(path.join(dir, 'a.txt'), folders), false, 'not a font extension');
    assert.equal(isSystemFont(path.join(dir, '..', 'a.ttf'), folders), false, 'outside through ..');
    assert.equal(isSystemFont(path.join(path.dirname(dir), 'x.ttf'), folders), false, 'another folder');
    assert.equal(isSystemFont(`${path.join(dir, 'a.ttf')}\0.txt`, folders), false);
    assert.equal(isSystemFont('', folders), false);
    assert.equal(isSystemFont(undefined, folders), false);
    assert.equal((await readSystemFont(path.join(dir, 'a.ttf'), folders)).toString(), 'font');
    assert.equal(await readSystemFont(path.join(dir, 'missing.ttf'), folders), null, 'no such font here');
    await assert.rejects(() => readSystemFont(path.join(dir, 'a.txt'), folders), /Only a font file/);
    await assert.rejects(() => readSystemFont(path.join(os.homedir(), 'secret.ttf'), folders), /Only a font file/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('the default folders are the operating system\'s', () => {
  assert.equal(fontFolders('win32', {WINDIR: 'C:\\Windows'}).some(f => /Windows[\\/]Fonts[\\/]$/i.test(f)), true);
  assert.equal(fontFolders('darwin', {}).includes(path.resolve('/System/Library/Fonts') + path.sep), true);
  assert.equal(fontFolders('linux', {}).includes(path.resolve('/usr/share/fonts') + path.sep), true);
});

const haveSegoe = await fs.stat('C:/Windows/Fonts/segoeui.ttf').then(() => true, () => false);

test('a window with no file system gets its fonts from the host, and keeps them for the next text', {skip: haveSegoe ? false : 'Segoe UI is not installed here'}, async () => {
  const asked = [];
  globalThis.studio = {files: {readSystemFont: async file => { asked.push(file); return readSystemFont(file); }}};
  try {
    const text = String.fromCodePoint(0x41F, 0x440, 0x438, 0x432, 0x435, 0x442);
    const uni = await unicodeFor(await PDFDocument.create(), [text]);
    assert.equal(uni.canDraw(text), true, 'the host font draws Cyrillic');
    assert.ok(asked.length >= 1 && asked.every(f => /Fonts/i.test(f) && /\.(ttf|ttc|otf)$/i.test(f)), asked.join(', '));
    const first = asked.length;
    const again = await unicodeFor(await PDFDocument.create(), [text]);
    assert.equal(again.canDraw(text), true);
    assert.equal(asked.length, first, 'a font already read is not asked for again');
  } finally { delete globalThis.studio; }
});

test('a host that refuses the fonts leaves the text undrawable, not a crash', async () => {
  globalThis.studio = {files: {readSystemFont: async () => { throw new Error('forbidden'); }}};
  try {
    const text = String.fromCodePoint(0x10FFFC);
    const uni = await unicodeFor(await PDFDocument.create(), [text]);
    assert.equal(uni.canDraw(text), false);
  } finally { delete globalThis.studio; }
});
