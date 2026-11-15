// File > Save / Save As / Open for Prism through the format worker's contract (electron/formats-v2.cjs).
//
// Behaviour fidelity (docs/behaviour-fidelity.md):
// 1. What does ArtCraft do? deckcraft's File > Save (crates/engine cmd/file.rs → pptx::export,
//    write.rs:export) writes the open presentation as a .pptx PowerPoint opens without repair, and
//    File > Open (pptx::import_checked, read.rs) reads one back into the model; PowerPoint does the
//    same with its own files.
// 2. Does ours do the same? The format worker finds core/prism/formats/pptx-write.mjs / pptx-read.mjs
//    through core/generated/prism.formats.mjs; saving a schema-2 deck gives .pptx bytes, opening them
//    gives schema-2 content that validates and equals what was saved (masters, layouts, slides,
//    shapes, text, notes, transitions, animations).
// 3. Which test proves it? This file (format worker contract, no Electron), the upstream ports in
//    tests/prism/upstream/pptx_*.test.mjs, and tests/e2e/prism/formats-pptx.e2e.mjs (bridge E2E).

import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {richDeck} from './formats-pptx-fixtures.mjs';
import {createFile, validateFile} from '../../core/model.mjs';
import {formats} from '../../core/generated/prism.formats.mjs';

const require = createRequire(import.meta.url);
const {exportFile, importFile} = require('../../electron/formats-v2.cjs');

test('the generated format index offers pptx read and write, and pdf write, for Prism', () => {
  assert.equal(typeof formats.pptx?.read?.read, 'function');
  assert.equal(typeof formats.pptx?.write?.write, 'function');
  assert.equal(typeof formats.pdf?.write?.write, 'function');
});

test('File > Save writes a .pptx and File > Open reads the same deck back', async () => {
  const file = createFile('prism', 'Quarterly review', {schema: 2});
  file.content = richDeck();
  validateFile(file);
  const bytes = await exportFile(file, 'pptx');
  assert.ok(bytes instanceof Uint8Array && bytes.length > 1000);
  assert.deepEqual([...bytes.slice(0, 2)], [0x50, 0x4B], 'a zip package');
  const back = await importFile(bytes, 'pptx', {title: 'Quarterly review', kind: 'prism', newHost: true});
  assert.equal(back.kind, 'prism');
  assert.equal(back.schema, 2);
  const c = back.content;
  assert.equal(c.slides.length, file.content.slides.length);
  assert.equal(c.props.title, 'Rich deck');
  const texts = p => p.slides.map(s => s.shapes.map(sh => (sh.text?.paragraphs ?? []).map(pp => (pp.runs ?? []).map(r => r.text).join('')).join('\n')));
  assert.deepEqual(texts(c), texts(file.content));
  assert.deepEqual(c.slides.map(s => s.transition?.kind ?? null), file.content.slides.map(s => s.transition?.kind ?? null));
  assert.deepEqual(c.slides.map(s => s.animations.length), file.content.slides.map(s => s.animations.length));
});

test('saving a deck twice gives the same document (a save does not drift)', async () => {
  const file = createFile('prism', 'Drift', {schema: 2});
  file.content = richDeck();
  const once = await importFile(await exportFile(file, 'pptx'), 'pptx', {title: 'Drift', kind: 'prism', newHost: true});
  const twice = await importFile(await exportFile(once, 'pptx'), 'pptx', {title: 'Drift', kind: 'prism', newHost: true});
  const strip = c => JSON.stringify(c.slides.map(s => s.shapes.map(sh => [sh.kind.type, sh.name, sh.xfrm, sh.geom, sh.fill, sh.line, sh.text])));
  assert.equal(strip(twice.content), strip(once.content));
});

test('Save As PDF without the slide renderer refuses instead of drawing a lookalike', async () => {
  const file = createFile('prism', 'No renderer', {schema: 2});
  await assert.rejects(exportFile(file, 'pdf'), /slide renderer/);
});
