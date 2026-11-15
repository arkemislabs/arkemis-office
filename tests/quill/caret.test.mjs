// Quill caret family (core/quill/commands/caret.mjs): caret movement and selection.
//
// 1. What ArtCraft does: wordcraft crates/engine/src/cmd/caret.rs `specs` (caret.left … select.collapse):
//    Left/Right by character (a selection collapses to its edge), Ctrl+Left/Right by word, Up/Down
//    keeping the goal x on the laid-out lines, Home/End by line, Ctrl+Up/Down by paragraph,
//    Ctrl+Home/End, Page Up/Down by page, Shift extends; double-click word, Ctrl+click sentence,
//    triple-click paragraph, selection-bar click line, Select All growing cell → row → table →
//    document in a table. Word does the same.
// 2. Ours: the same moves over the schema-2 model and the translated layout (the page view's own
//    layout in a window, through src/apps/quill/ui-commands/caret.ts); view state (goal x, page
//    hint) in the kernel's document view. These commands change no content and add no undo step.
// 3. This file (every caret.* and select.* id, bridge params) and tests/e2e/quill/text-editing.e2e.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {s, run, typ, typed, sel, pos, setSel, addr, bodyParas, undoDepth} from './text-fixture.mjs';

const at = t => sel(t).focus;
const range = t => { const r = sel(t); return [r.anchor, r.focus]; };
const selectedText = t => {
  const [a, b] = range(t);
  if (a.path[0] !== b.path[0]) return null;
  const x = Math.min(a.off, b.off), y = Math.max(a.off, b.off);
  return bodyParas(t)[a.path[0]].text.slice(x, y);
};

test('caret.left / caret.right move a character; Shift extends; a selection collapses to its edge', async () => {
  const t = await typed('abc');
  await run(t, 'caret.left');
  assert.deepEqual(at(t), pos(0, 2));
  await run(t, 'caret.left', {extend: true});
  assert.equal(selectedText(t), 'b');
  await run(t, 'caret.right');
  assert.deepEqual(range(t), [pos(0, 2), pos(0, 2)], 'Right collapses to the selection end');
  await run(t, 'caret.right');
  assert.deepEqual(at(t), pos(0, 3));
  await run(t, 'caret.right');
  assert.deepEqual(at(t), pos(0, 3), 'at the end it stays');
  assert.equal(undoDepth(t), 1, 'moves add no undo step');
});

test('caret.wordLeft / caret.wordRight move by word', async () => {
  const t = await typed('one two three');
  await run(t, 'caret.wordLeft');
  assert.deepEqual(at(t), pos(0, 8));
  await run(t, 'caret.wordLeft');
  assert.deepEqual(at(t), pos(0, 4));
  await run(t, 'caret.wordRight');
  assert.deepEqual(at(t), pos(0, 8));
});

test('caret.home / caret.end go to the line edges; up/down keep the column', async () => {
  const t = await typed('first line\nsecond line\nthird');
  await setSel(t, pos(1, 3));
  await run(t, 'caret.home');
  assert.deepEqual(at(t), pos(1, 0));
  await run(t, 'caret.end');
  assert.deepEqual(at(t), pos(1, 11));
  await setSel(t, pos(1, 3));
  await run(t, 'caret.up');
  assert.equal(at(t).path[0], 0);
  assert.ok(Math.abs(at(t).off - 3) <= 1, `column kept: ${at(t).off}`);
  await run(t, 'caret.down');
  await run(t, 'caret.down');
  assert.equal(at(t).path[0], 2);
  await run(t, 'caret.up', {extend: true});
  assert.equal(sel(t).anchor.path[0], 2);
  assert.equal(sel(t).focus.path[0], 1);
});

test('caret.paraUp / caret.paraDown / caret.docStart / caret.docEnd', async () => {
  const t = await typed('one\ntwo\nthree');
  await setSel(t, pos(1, 2));
  await run(t, 'caret.paraUp');
  assert.deepEqual(at(t), pos(1, 0));
  await run(t, 'caret.paraUp');
  assert.deepEqual(at(t), pos(0, 0));
  await run(t, 'caret.paraDown');
  assert.deepEqual(at(t), pos(1, 0));
  await run(t, 'caret.docEnd');
  assert.deepEqual(at(t), pos(2, 5));
  await run(t, 'caret.docStart', {extend: true});
  assert.deepEqual(range(t), [pos(2, 5), pos(0, 0)]);
});

test('caret.pageDown / caret.pageUp move a page in the layout', async () => {
  const t = await s();
  await run(t, 'text.insert', {text: Array.from({length: 120}, (_, i) => `Line ${i + 1}`).join('\n'), paragraphs: true, raw: true});
  await run(t, 'caret.docStart');
  await run(t, 'caret.pageDown');
  const down = at(t).path[0];
  assert.ok(down > 10, `a page further down: ${down}`);
  await run(t, 'caret.pageUp');
  assert.ok(at(t).path[0] < down, 'back up');
});

test('caret.set takes an address, {story, path, off}, {block, off} or a point on a page', async () => {
  const t = await typed('hello\nworld');
  await run(t, 'caret.set', {pos: addr(t, pos(1, 2))});
  assert.deepEqual(at(t), pos(1, 2));
  await run(t, 'caret.set', {pos: {story: 'body', path: [0], off: 4}});
  assert.deepEqual(at(t), pos(0, 4));
  await run(t, 'caret.set', {pos: {block: 1, off: 5}, extend: true});
  assert.deepEqual(range(t), [pos(0, 4), pos(1, 5)]);
  await run(t, 'caret.set', {page: 0, x: 0, y: 0});
  assert.equal(at(t).path[0], 0);
  await assert.rejects(t.bridge('caret.set', {pos: {nope: 1}}), e => e.code === 'invalid_params');
});

test('select.all, select.range, select.text and select.collapse', async () => {
  const t = await typed('one two\nthree');
  await run(t, 'select.all');
  assert.deepEqual(range(t), [pos(0, 0), pos(1, 5)]);
  await run(t, 'select.collapse', {end: true});
  assert.deepEqual(range(t), [pos(1, 5), pos(1, 5)]);
  await run(t, 'select.range', {anchor: addr(t, pos(0, 0)), focus: addr(t, pos(0, 3))});
  assert.equal(selectedText(t), 'One');
  await run(t, 'select.collapse');
  assert.deepEqual(range(t), [pos(0, 0), pos(0, 0)]);
  await run(t, 'select.text', {text: 'e', occurrence: 2});
  assert.deepEqual(range(t), [pos(1, 3), pos(1, 4)]);
  assert.deepEqual([].concat(t.registry.get('select.all').shortcut), ['Mod+A']);
});

test('select.all in a table grows cell, row, table, then the document', async () => {
  const t = await s();
  await typ(t, 'before');
  await run(t, 'insert.table', {rows: 2, cols: 2});
  await typ(t, 'x');
  const steps = [];
  for (let i = 0; i < 4; i++) { await run(t, 'select.all'); steps.push(JSON.stringify(t.doc.selection)); }
  assert.equal(new Set(steps).size, 4, 'each Select All selects more');
  await run(t, 'select.all', {whole: true});
  assert.equal(sel(t).anchor.path.length, 1);
});

test('select.word, select.sentence, select.paragraph, select.line', async () => {
  const t = await typed('First one here. Second sentence now.\nNext');
  await setSel(t, pos(0, 2));
  await run(t, 'select.word');
  assert.equal(selectedText(t), 'First ');
  await setSel(t, pos(0, 20));
  await run(t, 'select.sentence');
  assert.equal(selectedText(t), 'Second sentence now.');
  await run(t, 'select.paragraph');
  const [a, b] = range(t);
  assert.deepEqual(a, pos(0, 0));
  assert.ok(b.path[0] === 1 && b.off === 0 || b.off === 36, 'the paragraph with its mark');
  await run(t, 'select.line', {pos: addr(t, pos(1, 1))});
  assert.equal(range(t)[0].path[0], 1);
});

test('select.dragUnit grows a word selection by whole words', async () => {
  const t = await typed('alpha beta gamma');
  await run(t, 'select.dragUnit', {unit: 'word', start: addr(t, pos(0, 0)), end: addr(t, pos(0, 6)), pos: addr(t, pos(0, 12))});
  assert.equal(selectedText(t), 'Alpha beta gamma');
});

test('bridge: caret commands are reads (no approval, no undo, no content change)', async () => {
  const t = await typed('abc');
  const before = structuredClone(t.content);
  const v = t.version;
  await t.bridge('caret.left');
  await t.bridge('select.all');
  assert.deepEqual(t.content, before);
  assert.equal(t.version, v);
  await assert.rejects(t.bridge('select.dragUnit', {unit: 'page'}), e => e.code === 'invalid_params');
});
